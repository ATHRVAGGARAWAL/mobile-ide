import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import type { ElicitationRequest, PermissionRequest, TimelineItem } from '@mobile-ide/core';
import { ElicitationCard } from '../elicitation';
import { T } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import { ApprovalBanner, type AttentionRequest } from './ApprovalBanner';
import { AssistantMessage } from './AssistantMessage';
import { ErrorItem } from './ErrorItem';
import { JumpToLatest } from './JumpToLatest';
import { PermissionItem } from './PermissionItem';
import { PlanCard } from './PlanCard';
import { ThoughtBlock } from './ThoughtBlock';
import { ToolCard } from './ToolCard';
import { TurnEnd } from './TurnEnd';
import { UserBubble } from './UserBubble';
import { KEYBOARD_DISMISS_ON_DRAG } from '../../lib/platform';

export interface TimelineListHandle {
  scrollToEnd: (animated?: boolean) => void;
  /** bring one item into the middle of the viewport */
  scrollToItemId: (id: string) => void;
}

export interface TimelineListProps {
  items: TimelineItem[];
  cwd: string;
  agent: string;
  agentName: string;
  onOpenPermission: (request: PermissionRequest) => void;
  /** tap on a pending agent question / URL hand-off: open the ElicitationSheet */
  onOpenElicitation: (request: ElicitationRequest) => void;
  ListEmptyComponent?: React.ReactElement | null;
}

type AttentionTimelineItem = Extract<TimelineItem, { kind: 'permission' | 'elicitation' }>;

interface RenderContext {
  items: TimelineItem[];
  cwd: string;
  agent: string;
  agentName: string;
  onOpenPermission: (request: PermissionRequest) => void;
  onOpenElicitation: (request: ElicitationRequest) => void;
  /** turnId -> ts of the user's prompt, for turn durations */
  turnStart: Record<string, number>;
  /**
   * item id -> expanded, for tool cards, thought blocks and assistant detail rows. Lives here, not in
   * the cells: FlashList v2 recycles a cell across items of the same type, so cell-local state would
   * follow the recycled component to an unrelated item. Absent = the item's default (failed tool calls
   * start open).
   */
  expanded: Record<string, boolean>;
  onToggle: (id: string, open: boolean) => void;
}

/** Distance from the bottom (px) within which we consider the user "following" the conversation. */
const BOTTOM_THRESHOLD = 120;

const MVCP = { autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true, animateAutoScrollToBottom: false } as const;

/** A pending permission card counts as on-screen once this much of it is visible. */
const VIEWABILITY = { itemVisiblePercentThreshold: 35 } as const;

/** Grace period before the sticky banner appears for a card that was just appended (lets autoscroll and layout settle). */
const BANNER_DELAY_MS = 320;

const keyExtractor = (item: TimelineItem) => item.id;
const getItemType = (item: TimelineItem) => item.kind;

/** The first assistant chunk of a response (after the prompt, or after another turn) carries the agent label. */
function startsResponse(items: TimelineItem[], index: number, item: Extract<TimelineItem, { kind: 'assistant' }>): boolean {
  const prev = index > 0 ? items[index - 1] : undefined;
  if (!prev) return true;
  switch (prev.kind) {
    case 'user':
    case 'turn_end':
    case 'error':
    case 'system':
      return true;
    case 'permission':
    case 'elicitation':
      return prev.request.turnId !== item.turnId;
    default:
      return prev.turnId !== item.turnId;
  }
}

function renderTimelineItem(item: TimelineItem, index: number, ctx: RenderContext): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return <UserBubble blocks={item.blocks} cwd={ctx.cwd} />;
    case 'assistant':
      return (
        <AssistantMessage
          id={item.id}
          text={item.text}
          streaming={item.streaming}
          ts={item.ts}
          agent={ctx.agent}
          agentName={ctx.agentName}
          showLabel={startsResponse(ctx.items, index, item)}
          open={ctx.expanded[item.id] ?? false}
          onToggle={ctx.onToggle}
        />
      );
    case 'thought':
      return (
        <ThoughtBlock
          id={item.id}
          text={item.text}
          streaming={item.streaming}
          open={ctx.expanded[item.id] ?? false}
          onToggle={ctx.onToggle}
        />
      );
    case 'tool':
      return <ToolCard item={item} cwd={ctx.cwd} open={ctx.expanded[item.id] ?? item.status === 'failed'} onToggle={ctx.onToggle} />;
    case 'plan':
      return <PlanCard id={item.id} entries={item.entries} open={ctx.expanded[item.id] ?? true} onToggle={ctx.onToggle} />;
    case 'permission':
      // no sessionTitle: inside its own session the card's footer would only repeat the header (the inbox passes it)
      return <PermissionItem request={item.request} resolved={item.resolved} onOpen={ctx.onOpenPermission} />;
    case 'elicitation':
      return (
        <ElicitationCard
          request={item.request}
          resolved={item.resolved}
          onPress={() => {
            if (!item.resolved) ctx.onOpenElicitation(item.request);
          }}
        />
      );
    case 'turn_end': {
      const start = ctx.turnStart[item.turnId];
      return <TurnEnd stopReason={item.stopReason} usage={item.usage} durationMs={start !== undefined ? item.ts - start : undefined} />;
    }
    case 'error':
      return <ErrorItem message={item.message} fatal={item.fatal} />;
    case 'system':
      return (
        <T variant="caption" color="textFaint" align="center" style={{ paddingVertical: 4 }}>
          {item.text}
        </T>
      );
  }
}

function sameRequests(a: AttentionRequest[], b: AttentionRequest[]): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
}

function attentionRequest(item: AttentionTimelineItem): AttentionRequest {
  return item.kind === 'permission'
    ? { kind: 'permission', id: item.id, request: item.request }
    : { kind: 'elicitation', id: item.id, request: item.request };
}

/**
 * The conversation. FlashList v2 with maintainVisibleContentPosition keeps the view pinned to the
 * bottom while streaming and stable when history is inserted above; a pill offers "jump to latest"
 * once the user scrolls up, and a sticky strip surfaces a pending permission whose card is off-screen.
 */
export const TimelineList = forwardRef<TimelineListHandle, TimelineListProps>(function TimelineList(
  { items, cwd, agent, agentName, onOpenPermission, onOpenElicitation, ListEmptyComponent },
  ref,
) {
  const t = useTheme();
  const listRef = useRef<FlashListRef<TimelineItem>>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const atBottom = useRef(true);
  const prevLength = useRef(items.length);
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const onToggle = useCallback(
    (id: string, open: boolean) => setExpanded((prev) => (prev[id] === open ? prev : { ...prev, [id]: open })),
    [],
  );

  const scrollToEnd = useCallback((animated = true) => {
    listRef.current?.scrollToEnd({ animated });
    atBottom.current = true;
    setShowJump(false);
    setNewCount(0);
  }, []);

  const scrollToItemId = useCallback((id: string) => {
    const index = itemsRef.current.findIndex((it) => it.id === id);
    if (index < 0) return;
    void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToEnd, scrollToItemId }), [scrollToEnd, scrollToItemId]);

  useEffect(() => {
    const delta = items.length - prevLength.current;
    prevLength.current = items.length;
    if (delta > 0 && !atBottom.current) {
      setNewCount((n) => n + delta);
      setShowJump(true);
    }
  }, [items.length]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distance = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nowAtBottom = distance < BOTTOM_THRESHOLD;
    if (nowAtBottom === atBottom.current) return;
    atBottom.current = nowAtBottom;
    if (nowAtBottom) {
      setShowJump(false);
      setNewCount(0);
    } else if (contentSize.height > layoutMeasurement.height) {
      setShowJump(true);
    }
  }, []);

  // ---- pending permissions whose card is scrolled out of view -> sticky banner
  const pendingItems = useMemo(
    () => items.filter((it): it is AttentionTimelineItem => (it.kind === 'permission' || it.kind === 'elicitation') && !it.resolved),
    [items],
  );
  const pendingRef = useRef(pendingItems);
  pendingRef.current = pendingItems;
  const pendingKey = pendingItems.map((p) => p.id).join('|');
  const visibleIds = useRef<Set<string>>(new Set());
  const [offscreen, setOffscreen] = useState<AttentionRequest[]>([]);

  const recomputeOffscreen = useCallback(() => {
    const visible = visibleIds.current;
    const next = pendingRef.current
      .filter((p) => !visible.has(p.id))
      .map(attentionRequest)
      .sort((a, b) => a.request.createdAt - b.request.createdAt);
    setOffscreen((prev) => (sameRequests(prev, next) ? prev : next));
  }, []);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { item: TimelineItem; isViewable: boolean }[] }) => {
      const next = new Set<string>();
      for (const v of viewableItems) if (v.isViewable) next.add(v.item.id);
      visibleIds.current = next;
      recomputeOffscreen();
    },
    [recomputeOffscreen],
  );

  useEffect(() => {
    if (!pendingKey) {
      recomputeOffscreen();
      return;
    }
    const timer = setTimeout(recomputeOffscreen, BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pendingKey, recomputeOffscreen]);

  const reviewAttention = useCallback(
    (item: AttentionRequest) => {
      if (item.kind === 'permission') onOpenPermission(item.request);
      else onOpenElicitation(item.request);
    },
    [onOpenPermission, onOpenElicitation],
  );

  const turnStart = useMemo(() => {
    const map: Record<string, number> = {};
    for (const it of items) if (it.kind === 'user') map[it.turnId] = it.ts;
    return map;
  }, [items]);

  const ctx = useMemo<RenderContext>(
    () => ({ items, cwd, agent, agentName, onOpenPermission, onOpenElicitation, turnStart, expanded, onToggle }),
    [items, cwd, agent, agentName, onOpenPermission, onOpenElicitation, turnStart, expanded, onToggle],
  );
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TimelineItem>) => <View style={styles.cell}>{renderTimelineItem(item, index, ctx)}</View>,
    [ctx],
  );
  // Cells depend on the theme and turn map besides `data`; FlashList re-renders visible cells when extraData changes.
  const extraData = useMemo(() => ({ theme: t.name, ctx }), [t.name, ctx]);

  return (
    <View style={styles.root}>
      <FlashList
        ref={listRef}
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        extraData={extraData}
        onScroll={onScroll}
        scrollEventThrottle={32}
        maintainVisibleContentPosition={MVCP}
        drawDistance={800}
        viewabilityConfig={VIEWABILITY}
        onViewableItemsChanged={onViewableItemsChanged}
        contentContainerStyle={styles.content}
        keyboardDismissMode={KEYBOARD_DISMISS_ON_DRAG}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={ListEmptyComponent}
        showsVerticalScrollIndicator
      />
      <ApprovalBanner requests={offscreen} onReview={reviewAttention} onLocate={(item) => scrollToItemId(item.id)} />
      <JumpToLatest visible={showJump} count={newCount} onPress={() => scrollToEnd(true)} />
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 20 },
  cell: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingVertical: 6 },
});
