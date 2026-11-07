import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { describeTool, type TimelineItem, type ToolContent } from '@mobile-ide/core';
import DiffView, { type DiffSource } from '../../dom/DiffView';
import { Chip, CodeBlock, T, Tap } from '../ui';
import { useTheme } from '../../theme/ThemeProvider';
import type { ToolLocation } from '@mobile-ide/core';
import { basename, commandOf, formatDuration, pluralize, stringifyInput, stripAnsi } from '../../lib/format';
import { INLINE_DOM } from './domProps';
import { openFile, relativeToRoot } from './files';
import { toolIcon, toolKindLabel, toolStatusLabel } from './toolMeta';

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export interface ToolCardProps {
  item: ToolItem;
  cwd: string;
  /**
   * Controlled expand state. FlashList recycles cells across items of the same type, so a `useState`
   * inside the cell would jump to unrelated tool calls on scroll; the list owns it, keyed by item id.
   */
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}

/** Ticks once a second while the tool runs; frozen afterwards. */
function useElapsed(startTs: number, running: boolean, endedTs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!running) return endedTs !== undefined ? Math.max(0, endedTs - startTs) : 0;
  return Math.max(0, now - startTs);
}

/**
 * OpenCode reports the working directory itself as a "location" of every shell command; that is not a file the
 * viewer can open (`/file?path=.`), so it is neither counted nor offered as a chip.
 */
function fileLocationsOf(locations: ToolLocation[], cwd: string): ToolLocation[] {
  if (!cwd) return locations;
  return locations.filter((loc) => relativeToRoot(cwd, loc.path) !== '.');
}

function ToolCardInner({ item, cwd, open, onToggle }: ToolCardProps) {
  const t = useTheme();
  const c = t.colors;
  const unfinished = item.status === 'pending' || item.status === 'in_progress';
  // a call whose permission request is still open has not started: no spinner, no ticking timer
  const waiting = unfinished && item.awaitingPermission === true;
  const running = unfinished && !waiting;
  const elapsed = useElapsed(item.startedTs ?? item.ts, running, item.endedTs);
  const command = item.toolKind === 'execute' ? commandOf(item.rawInput) : null;
  const label = describeTool(item.title, item.toolKind, item.rawInput);
  const diffCount = item.content.filter((x) => x.type === 'diff').length;
  const locations = useMemo(() => fileLocationsOf(item.locations, cwd), [item.locations, cwd]);
  const statusColor = item.status === 'failed' ? c.danger : item.status === 'completed' ? c.textMuted : c.accent;
  const showDuration = running || item.endedTs !== undefined;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.surface, borderColor: item.status === 'failed' ? c.danger : c.border, borderRadius: t.radius.lg },
      ]}
    >
      <Tap
        onPress={() => onToggle(item.id, !open)}
        pressedColor={null}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // react-native-web maps aria-* props but not accessibilityState.expanded
        aria-expanded={open}
        accessibilityLabel={`${toolKindLabel(item.toolKind)}: ${label}${waiting ? ', waiting for approval' : ''}`}
        style={styles.head}
      >
        <View style={[styles.iconBox, { backgroundColor: waiting ? c.accentSoft : c.surfaceAlt }]}>
          {waiting ? (
            <Ionicons name="hand-left-outline" size={16} color={c.accent} />
          ) : running ? (
            <ActivityIndicator size="small" color={c.accent} style={{ transform: [{ scale: 0.75 }] }} />
          ) : (
            <Ionicons name={toolIcon(item.toolKind)} size={16} color={statusColor} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant={command ? 'monoSmall' : 'bodySmall'} weight={command ? '400' : '500'} numberOfLines={2}>
            {label}
          </T>
          <View style={styles.meta}>
            <T variant="caption" color="textFaint">
              {toolKindLabel(item.toolKind)}
            </T>
            {label !== item.title ? (
              <T variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1 }}>
                · {item.title}
              </T>
            ) : null}
            {diffCount ? (
              <T variant="caption" color="textFaint">
                · {diffCount === 1 ? 'diff' : `${diffCount} diffs`}
              </T>
            ) : null}
            {locations.length ? (
              <T variant="caption" color="textFaint">
                · {pluralize(locations.length, 'file')}
              </T>
            ) : null}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4, maxWidth: 92 }}>
          {item.status === 'failed' ? (
            <Chip label="Failed" bg={c.dangerSoft} fg={c.danger} />
          ) : waiting ? (
            <T variant="caption" weight="600" style={{ color: c.accent }}>
              Needs approval
            </T>
          ) : showDuration ? (
            <T variant="caption" color={running ? 'accent' : 'textFaint'}>
              {formatDuration(elapsed)}
            </T>
          ) : (
            <T variant="caption" color="textFaint">
              {toolStatusLabel(item.status)}
            </T>
          )}
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={c.textFaint} />
        </View>
      </Tap>
      {open ? <ToolBody item={item} cwd={cwd} command={command} locations={locations} /> : null}
    </View>
  );
}

function ToolBody({
  item,
  cwd,
  command,
  locations,
}: Pick<ToolCardProps, 'item' | 'cwd'> & { command: string | null; locations: ToolLocation[] }) {
  const t = useTheme();
  const inputText = command ?? (item.rawInput !== undefined ? stringifyInput(item.rawInput) : '');
  const outputText = item.rawOutput !== undefined ? stringifyInput(item.rawOutput) : '';
  const contentShowsOutput = item.content.some((x) => x.type === 'terminal' || (x.type === 'content' && x.content.type === 'text'));
  const showRawOutput = outputText.length > 0 && !contentShowsOutput;
  const empty = !inputText && !item.content.length && !showRawOutput && !locations.length;
  return (
    <View style={[styles.body, { borderTopColor: t.colors.border }]}>
      {inputText ? <CodeBlock label={command ? 'Command' : 'Input'} code={inputText} maxHeight={260} /> : null}
      {item.content.map((block, i) => (
        <ToolContentBlock key={i} block={block} cwd={cwd} />
      ))}
      {showRawOutput ? (
        <CodeBlock label="Output" code={outputText} maxHeight={320} tone={item.status === 'failed' ? 'danger' : 'default'} />
      ) : null}
      {locations.length ? (
        <View style={styles.chips}>
          {locations.map((loc, i) => (
            <Chip
              key={`${loc.path}:${loc.line ?? ''}:${i}`}
              icon="document-text-outline"
              label={loc.line ? `${basename(loc.path)}:${loc.line}` : basename(loc.path)}
              size="md"
              mono
              maxWidth={260}
              onPress={() => openFile(cwd, loc.path, loc.line)}
            />
          ))}
        </View>
      ) : null}
      {empty ? (
        <T variant="caption" color="textFaint">
          The agent reported no details for this call.
        </T>
      ) : null}
    </View>
  );
}

function DiffBlock({ path, oldText, newText, cwd }: { path: string; oldText: string | null; newText: string; cwd: string }) {
  const t = useTheme();
  const rel = relativeToRoot(cwd, path);
  const source = useMemo<DiffSource>(() => ({ kind: 'texts', path: rel, oldText, newText }), [rel, oldText, newText]);
  return (
    <View style={{ gap: 4 }}>
      <Tap
        onPress={() => openFile(cwd, path)}
        pressedColor={null}
        accessibilityRole="link"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}
      >
        <Ionicons name="git-compare-outline" size={13} color={t.colors.textMuted} />
        <T variant="monoSmall" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {rel}
        </T>
      </Tap>
      <DiffView source={source} theme={t.name} wrap maxLines={160} dom={INLINE_DOM} />
    </View>
  );
}

function ToolContentBlock({ block, cwd }: { block: ToolContent; cwd: string }) {
  switch (block.type) {
    case 'diff':
      return <DiffBlock path={block.path} oldText={block.oldText} newText={block.newText} cwd={cwd} />;
    case 'terminal': {
      const out = stripAnsi(block.output ?? '').replace(/\s+$/, '');
      const exit = block.exitCode;
      const label = exit === null || exit === undefined ? 'Terminal' : `Terminal · exit ${exit}`;
      return (
        <CodeBlock
          label={label}
          code={out || '(no output captured)'}
          maxHeight={320}
          tone={typeof exit === 'number' && exit !== 0 ? 'danger' : 'default'}
        />
      );
    }
    case 'content': {
      const cb = block.content;
      if (cb.type === 'text') return <CodeBlock label="Output" code={cb.text} maxHeight={320} />;
      if (cb.type === 'image') {
        return (
          <Image
            source={{ uri: `data:${cb.mimeType};base64,${cb.data}` }}
            style={{ width: '100%', height: 220, borderRadius: 10 }}
            resizeMode="contain"
            accessibilityLabel="Image from tool"
          />
        );
      }
      return <Chip icon="link-outline" label={cb.name || cb.uri} size="md" mono maxWidth={300} onPress={() => openFile(cwd, cb.uri)} />;
    }
  }
}

/**
 * The store publishes a shallow clone of every item per snapshot (state/sessions.ts `snapshot`), so the item
 * reference changes on every publish: compare the fields that matter instead, so a streaming session does not
 * re-render every visible tool card per frame. (Arrays/objects below are replaced by the reducer, never mutated.)
 */
export const ToolCard = React.memo(ToolCardInner, (a, b) => {
  const x = a.item;
  const y = b.item;
  return (
    a.cwd === b.cwd &&
    a.open === b.open &&
    a.onToggle === b.onToggle &&
    x.id === y.id &&
    x.status === y.status &&
    x.title === y.title &&
    x.toolKind === y.toolKind &&
    x.content === y.content &&
    x.locations === y.locations &&
    x.rawInput === y.rawInput &&
    x.rawOutput === y.rawOutput &&
    x.ts === y.ts &&
    x.endedTs === y.endedTs &&
    x.awaitingPermission === y.awaitingPermission &&
    x.startedTs === y.startedTs
  );
});

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14, minHeight: 72 },
  iconBox: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  body: { borderTopWidth: StyleSheet.hairlineWidth, padding: 14, gap: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
