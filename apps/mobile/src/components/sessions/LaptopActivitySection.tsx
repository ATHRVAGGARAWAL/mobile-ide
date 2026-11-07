import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { LaptopActivity, LaptopHistory, LaptopSession, LiveLaptopWork, SessionSummary } from '@mobile-ide/core';
import { api, errorMessage } from '../../state/api';
import { useProjects } from '../../state/projects';
import { useTheme } from '../../theme/ThemeProvider';
import { Banner, Button, SectionHeader, Sheet, T, Tap } from '../ui';

interface Props {
  data: LaptopActivity | null;
  error: string | null;
  sessions: SessionSummary[];
  refresh: () => Promise<void>;
}
const projectName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

export function LaptopActivitySection({ data, error, sessions, refresh }: Props) {
  const t = useTheme();
  const router = useRouter();
  const [selected, setSelected] = useState<LaptopSession | null>(null);
  const [native, setNative] = useState<LiveLaptopWork | null>(null);
  const [history, setHistory] = useState<LaptopHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [provider, setProvider] = useState('All');
  useEffect(() => {
    let current = true;
    setHistory(null);
    setHistoryError(null);
    if (selected)
      void api.laptopHistory(selected.source, selected.id).then(
        (result) => {
          if (current) setHistory(result);
        },
        (err) => {
          if (current) setHistoryError(errorMessage(err));
        },
      );
    return () => {
      current = false;
    };
  }, [selected, retry]);
  const card = {
    padding: 14,
    gap: 6,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
  };
  const activeChats = sessions.filter((s) => ['running', 'starting', 'needs_you'].includes(s.status));
  const recent = [
    ...(data?.recent ?? []).map((s) => ({
      key: `${s.source}:${s.id}`,
      title: s.title,
      cwd: s.cwd,
      source: s.source === 'codex' ? 'Codex' : 'Claude',
      updatedAt: s.updatedAt,
      open: () => setSelected(s),
      action: 'View saved messages',
    })),
    ...sessions
      .filter((s) => !activeChats.includes(s))
      .map((s) => ({
        key: `chat:${s.id}`,
        title: s.title,
        cwd: s.cwd,
        source: 'Mobile IDE chat',
        updatedAt: s.updatedAt,
        open: () => router.push({ pathname: '/session/[id]', params: { id: s.id } }),
        action: 'Open chat',
      })),
  ]
    .filter((s) => provider === 'All' || s.source === provider)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <View style={{ paddingBottom: 12 }}>
      <SectionHeader title="Active now" />
      <View style={{ paddingHorizontal: 20, gap: 10 }}>
        {error ? (
          <Banner
            tone="warning"
            message={`Laptop activity could not refresh: ${error}. Displayed items may be out of date.`}
            actionLabel="Retry"
            onAction={() => void refresh()}
            compact
          />
        ) : null}
        {data?.warnings.map((warning) => (
          <Banner key={warning} tone="warning" message={warning} compact />
        ))}
        {!data && !error ? (
          <T color="textMuted" variant="bodySmall">
            Checking laptop activity…
          </T>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          {data?.live.map((work) => (
            <Tap
              key={work.id}
              style={[card, { width: 270 }]}
              accessibilityRole="button"
              onPress={() => {
                if (work.terminalId) {
                  useProjects.getState().openTerminal(work.cwd, work.terminalId);
                  router.push('/(tabs)/terminal');
                } else setNative(work);
              }}
            >
              <T variant="caption" color="accent">
                {work.terminalId ? 'Live shared terminal' : 'Open on laptop'} · {work.command}
              </T>
              <T variant="subheading" numberOfLines={1}>
                {projectName(work.cwd)}
              </T>
              <T variant="bodySmall" color="textMuted" numberOfLines={2}>
                {work.title}
              </T>
              <T variant="caption">{work.terminalId ? 'Open live terminal →' : 'Connection details →'}</T>
            </Tap>
          ))}
          {activeChats.map((s) => (
            <Tap
              key={s.id}
              style={[card, { width: 270 }]}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/session/[id]', params: { id: s.id } })}
            >
              <T variant="caption" color="accent">
                Mobile IDE · {s.status.replace(/_/g, ' ')}
              </T>
              <T variant="subheading" numberOfLines={2}>
                {s.title}
              </T>
              <T variant="caption">{projectName(s.cwd)} · Open chat →</T>
            </Tap>
          ))}
        </ScrollView>
        {(data?.live.length ?? 0) + activeChats.length > 1 ? (
          <T variant="caption" color="textMuted">
            Swipe to see all open sessions →
          </T>
        ) : null}
        {data && !data.live.length && !activeChats.length ? (
          <T variant="bodySmall" color="textMuted">
            No open terminals or running chats found.
          </T>
        ) : null}
        <T variant="caption" color="textFaint">
          Refreshes every 8 seconds while this screen is open. An open terminal may be waiting for you.
        </T>
      </View>
      <SectionHeader title="Last session & recent work" />
      <View style={{ paddingHorizontal: 20, gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {['All', 'Codex', 'Claude', 'Mobile IDE chat'].map((source) => (
            <Tap
              key={source}
              accessibilityRole="button"
              accessibilityState={{ selected: provider === source }}
              onPress={() => {
                setProvider(source);
                setExpanded(false);
              }}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 12,
                borderRadius: t.radius.md,
                backgroundColor: provider === source ? t.colors.text : t.colors.surfaceAlt,
              }}
            >
              <T variant="caption" color={provider === source ? 'bg' : 'textMuted'}>
                {source}
              </T>
            </Tap>
          ))}
        </ScrollView>
        {recent.slice(0, expanded ? 12 : 3).map((s, i) => (
          <Tap key={s.key} style={card} onPress={s.open} accessibilityRole="button">
            <T variant="caption" color={i === 0 ? 'accent' : 'textMuted'}>
              {i === 0 ? 'Last session · ' : ''}
              {s.source} · {projectName(s.cwd)}
            </T>
            <T variant="subheading" numberOfLines={2}>
              {s.title}
            </T>
            <T variant="caption" color="textFaint">
              {new Date(s.updatedAt).toLocaleString()}
            </T>
            <T variant="caption">{s.action} →</T>
          </Tap>
        ))}
        {data && !recent.length ? (
          <T variant="bodySmall" color="textMuted">
            Saved Codex, Claude and Mobile IDE sessions will appear here.
          </T>
        ) : null}
        {recent.length > 3 ? (
          <Button variant="ghost" title={expanded ? 'Show less' : 'More recent sessions'} onPress={() => setExpanded(!expanded)} />
        ) : null}
      </View>
      <Sheet visible={!!selected} onClose={() => setSelected(null)} title={selected?.title} subtitle={selected?.cwd}>
        <View style={{ gap: 14 }}>
          {!history && !historyError ? <T>Loading saved messages…</T> : null}
          {historyError ? <Banner tone="warning" message={historyError} actionLabel="Retry" onAction={() => setRetry(retry + 1)} /> : null}
          {history ? (
            <T variant="caption" color="textMuted">
              {history.note}
            </T>
          ) : null}
          {history?.messages.map((message, i) => (
            <View key={i} style={card}>
              <T variant="label">{message.role === 'user' ? 'You' : selected?.source}</T>
              <T selectable variant="bodySmall">
                {message.text}
              </T>
            </View>
          ))}
          {history && !history.messages.length ? <T>No saved message text is available for this session.</T> : null}
        </View>
      </Sheet>
      <Sheet visible={!!native} onClose={() => setNative(null)} title={native?.title} subtitle={native?.cwd}>
        <T>
          This session was opened outside Mobile IDE’s shared terminal. Its live screen cannot be attached from the phone. You can view its
          saved work under Recent work. Start future sessions in Mobile IDE’s Terminal tab to share the same live screen with your laptop.
        </T>
      </Sheet>
    </View>
  );
}
