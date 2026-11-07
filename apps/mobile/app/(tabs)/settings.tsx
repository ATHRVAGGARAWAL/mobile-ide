/**
 * Settings: server + device info, connection test, daemon update check, notification channels
 * (Expo push / Web Push / ntfy) with live status, appearance, about/diagnostics, and "Forget this server".
 */
import type { HealthResponse } from '@mobile-ide/core';
import { Ionicons } from '@expo/vector-icons';
import { router, useIsFocused } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, RefreshControl, ScrollView, useColorScheme, View } from 'react-native';
import {
  BrandMark,
  Button,
  Card,
  Chip,
  CodeBlock,
  ConnectionBanner,
  ConnectionDot,
  connectionLabel,
  Divider,
  ErrorView,
  IconButton,
  KeyValue,
  LoadingView,
  PageHeader,
  Screen,
  SectionHeader,
  Segmented,
  Sheet,
  T,
  Tap,
  TextField,
  useToastAnchor,
} from '../../src/components/ui';
import { copyText } from '../../src/lib/clipboard';
import { measureWebViewport } from '../../src/lib/safeArea';
import type { SafeAreaMode } from '../../src/state/settings';
import { formatDuration, relativeTime, truncate } from '../../src/lib/format';
import { channelToneColors, type ChannelStatus } from '../../src/lib/notificationStatus';
import {
  clearExpoPush,
  describeExpoPushStatus,
  openSystemNotificationSettings,
  registerExpoPush,
  useExpoPushStatus,
} from '../../src/lib/notifications';
import { isStandaloneWeb, isWeb } from '../../src/lib/platform';
import { touchKnownServer } from '../../src/lib/serverHistory';
import { useAsync } from '../../src/lib/useAsync';
import { useNow } from '../../src/lib/useNow';
import { appVersion, buildInfo, compareDaemonAndApp, PROTOCOL_VERSION, type UpdateVerdict } from '../../src/lib/version';
import {
  describeWebPushStatus,
  getWebPushStatus,
  loadManualVapidKey,
  subscribeWebPush,
  unsubscribeWebPush,
  type WebPushStatus,
} from '../../src/lib/webpush';
import { api, ApiError, errorMessage } from '../../src/state/api';
import { useConnection } from '../../src/state/connection';
import { useProjects } from '../../src/state/projects';
import { useSessions } from '../../src/state/sessions';
import { isPaired, normalizeServerUrl, useSettings } from '../../src/state/settings';
import { toast } from '../../src/state/toast';
import { themes, type Theme, type ThemePreference } from '../../src/theme';
import { useTheme } from '../../src/theme/ThemeProvider';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

export default function SettingsScreen() {
  const t = useTheme();
  const [section, setSection] = useState<'appearance' | 'notifications' | 'connection'>('appearance');
  const scrollRef = useRef<ScrollView>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const serverName = useSettings((s) => s.serverName);
  const deviceName = useSettings((s) => s.deviceName);
  const paired = useSettings((s) => isPaired(s));
  const connState = useConnection((s) => s.state);
  const health = useAsync(() => api.health(), [connState === 'open'], { enabled: paired });
  // toasts float above the tab bar while this tab is showing (not at the Sessions tab's FAB clearance)
  const toastAnchor = useToastAnchor({ enabled: useIsFocused() });

  return (
    <Screen edges={['top']}>
      <View style={{ flex: 1 }} ref={toastAnchor.ref} onLayout={toastAnchor.onLayout}>
        <View style={{ maxWidth: 760, width: '100%', alignSelf: 'center' }}>
          <PageHeader eyebrow="Your workspace" title="Settings" subtitle="Make yourself at home." />
        </View>
        <ConnectionBanner />
        <View style={{ maxWidth: 760, width: '100%', alignSelf: 'center', paddingHorizontal: t.spacing.lg, paddingBottom: 8, gap: 18 }}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <BrandMark size={42} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <T weight="600" numberOfLines={1}>
                {serverName ?? 'Your computer'}
              </T>
              <T variant="caption" color="textMuted" numberOfLines={1}>
                {deviceName ?? 'This device'}
              </T>
            </View>
            <ConnectionDot />
          </Card>
          <Segmented
            options={[
              { key: 'appearance', label: 'Appearance' },
              { key: 'notifications', label: 'Notifications' },
              { key: 'connection', label: 'Connection' },
            ]}
            value={section}
            onChange={(value) => {
              setSection(value);
              scrollRef.current?.scrollTo({ y: 0, animated: false });
            }}
          />
        </View>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingBottom: 40, maxWidth: 760, width: '100%', alignSelf: 'center' }}
          refreshControl={
            <RefreshControl refreshing={health.refreshing} onRefresh={() => void health.refresh()} tintColor={t.colors.accent} />
          }
          keyboardShouldPersistTaps="handled"
        >
          {/* Keep field drafts and diagnostic results while moving between categories. */}
          <View style={{ display: section === 'appearance' ? 'flex' : 'none' }}>
            <AppearanceSection />
          </View>
          <View style={{ display: section === 'notifications' ? 'flex' : 'none' }}>
            <NotificationsSection />
          </View>
          <View style={{ display: section === 'connection' ? 'flex' : 'none' }}>
            <ServerSection
              health={health.data}
              loading={health.loading}
              error={health.error}
              onRetry={() => void health.reload()}
              onHealth={health.setData}
            />
            <AgentsSection health={health.data} />
            <DeviceSection />
            <Tap
              onPress={() => setDiagnostics((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel="Diagnostics and app details"
              accessibilityState={{ expanded: diagnostics }}
              style={{
                marginHorizontal: t.spacing.lg,
                marginTop: 20,
                padding: 16,
                minHeight: 56,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.md,
                borderWidth: 1,
                borderColor: t.colors.border,
              }}
            >
              <Ionicons name="information-circle-outline" size={19} color={t.colors.textMuted} />
              <T variant="bodySmall" style={{ flex: 1 }} weight="600">
                Diagnostics & app details
              </T>
              <Ionicons name={diagnostics ? 'chevron-up' : 'chevron-down'} size={16} color={t.colors.textMuted} />
            </Tap>
            {diagnostics ? <AboutSection health={health.data} /> : null}
            <DangerSection />
          </View>
          <T variant="caption" color="textFaint" align="center" style={{ marginTop: 28, paddingHorizontal: 24 }}>
            mobile ide · {appVersion()}
          </T>
        </ScrollView>
      </View>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Server: identity, connection, test + update tools
// ---------------------------------------------------------------------------
function ServerSection({
  health,
  loading,
  error,
  onRetry,
  onHealth,
}: {
  health: HealthResponse | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onHealth: (h: HealthResponse | undefined) => void;
}) {
  const t = useTheme();
  const serverUrl = useSettings((s) => s.serverUrl);
  const serverName = useSettings((s) => s.serverName);
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const restart = useConnection((s) => s.restart);
  const outbox = useSessions((s) => s.outbox.length);
  const dotColor =
    state === 'open' ? t.colors.success : state === 'connecting' || state === 'reconnecting' ? t.colors.warning : t.colors.danger;
  const passiveVerdict = health ? compareDaemonAndApp(health.version) : null;

  return (
    <>
      <SectionHeader title="Server" />
      <Card padded={false} style={{ marginHorizontal: t.spacing.lg }}>
        <KeyValue label="Name" value={health?.serverName ?? serverName ?? '—'} />
        <Divider inset={t.spacing.lg} />
        <KeyValue label="URL" value={serverUrl ?? '—'} mono onPress={serverUrl ? () => void copy('Server URL', serverUrl) : undefined} />
        <Divider inset={t.spacing.lg} />
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingVertical: 10, gap: 12 }}>
          <T variant="bodySmall" color="textMuted" style={{ width: 84 }}>
            Connection
          </T>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
            <T variant="bodySmall">{connectionLabel(state, detail)}</T>
            {outbox > 0 ? <Chip label={`${outbox} queued`} /> : null}
          </View>
          <Button title={state === 'open' ? 'Reconnect' : 'Retry'} size="sm" variant="secondary" icon="refresh" onPress={restart} />
        </View>
        {health ? (
          <>
            <Divider inset={t.spacing.lg} />
            <KeyValue label="Daemon" value={`v${health.version} · up ${formatDuration(health.uptimeSec * 1000)}`} />
            <Divider inset={t.spacing.lg} />
            <KeyValue
              label="Sessions"
              value={`${health.sessions.total} total · ${health.sessions.running} running · ${health.sessions.needsYou} need you`}
            />
            {passiveVerdict && passiveVerdict.kind !== 'match' ? (
              <>
                <Divider inset={t.spacing.lg} />
                <VerdictLine verdict={passiveVerdict} />
              </>
            ) : null}
          </>
        ) : loading ? (
          <>
            <Divider inset={t.spacing.lg} />
            <LoadingView compact label="Loading daemon status…" />
          </>
        ) : error ? (
          <>
            <Divider inset={t.spacing.lg} />
            <ErrorView compact title="Daemon status unavailable" message={error} onRetry={onRetry} />
          </>
        ) : null}
        <Divider inset={t.spacing.lg} />
        <ServerTools serverUrl={serverUrl} onHealth={onHealth} />
      </Card>
    </>
  );
}

/** One-line nudge inside the Server card when the daemon and app versions differ. */
function VerdictLine({ verdict }: { verdict: UpdateVerdict }) {
  const t = useTheme();
  const tone = verdict.kind === 'daemon_behind' ? t.colors.warning : verdict.kind === 'app_behind' ? t.colors.info : t.colors.textMuted;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: t.spacing.lg, paddingVertical: 10 }}>
      <Ionicons name="arrow-up-circle-outline" size={16} color={tone} />
      <T variant="bodySmall" style={{ color: tone, flex: 1 }}>
        {verdict.title}. See “Check for update” below.
      </T>
    </View>
  );
}

type ConnTest =
  | { state: 'idle' }
  | { state: 'running' }
  | {
      state: 'done';
      at: number;
      reachable: boolean;
      latencyMs: number | null;
      serverName: string | null;
      version: string | null;
      /** null = could not be checked (daemon unreachable or a non-auth error) */
      tokenOk: boolean | null;
      message: string | null;
    };

type UpdateCheck =
  { state: 'idle' } | { state: 'running' } | { state: 'done'; at: number; verdict: UpdateVerdict } | { state: 'error'; message: string };

async function runConnectionTest(serverUrl: string): Promise<Extract<ConnTest, { state: 'done' }>> {
  const started = Date.now();
  let latencyMs: number | null = null;
  let serverName: string | null = null;
  let version: string | null = null;
  try {
    const h = await api.probe(serverUrl);
    latencyMs = Date.now() - started;
    serverName = h.serverName;
    version = h.version;
    touchKnownServer(serverUrl, { name: h.serverName, version: h.version });
  } catch (err) {
    return {
      state: 'done',
      at: Date.now(),
      reachable: false,
      latencyMs: null,
      serverName: null,
      version: null,
      tokenOk: null,
      message: probeFailureMessage(err),
    };
  }
  let tokenOk: boolean | null = null;
  let message: string | null = null;
  try {
    await api.health();
    tokenOk = true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'unauthorized') {
      tokenOk = false;
      message = 'The daemon rejected this device’s token — it was revoked or the daemon’s database was reset. Pair again to continue.';
    } else {
      message = `The daemon answered, but the authenticated status call failed: ${errorMessage(err)}`;
    }
  }
  return { state: 'done', at: Date.now(), reachable: true, latencyMs, serverName, version, tokenOk, message };
}

function probeFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_response' || err.code === 'not_found') {
      return 'Something answered at this URL, but it is not a mobile-ide daemon (unexpected /api/health reply). Check the port — 4820 by default — and your `tailscale serve` mapping.';
    }
    if (err.code === 'timeout') return 'No reply within 8 s. Is the laptop awake and on the tailnet?';
    return err.message;
  }
  return errorMessage(err);
}

function ServerTools({ serverUrl, onHealth }: { serverUrl: string | null; onHealth: (h: HealthResponse | undefined) => void }) {
  const t = useTheme();
  const wsState = useConnection((s) => s.state);
  const wsDetail = useConnection((s) => s.detail);
  const restart = useConnection((s) => s.restart);
  const [test, setTest] = useState<ConnTest>({ state: 'idle' });
  const [update, setUpdate] = useState<UpdateCheck>({ state: 'idle' });
  const now = useNow(test.state === 'done' || update.state === 'done' ? 30_000 : 0);

  const onTest = async () => {
    if (!serverUrl) return;
    setTest({ state: 'running' });
    setTest(await runConnectionTest(serverUrl));
  };

  const onCheckUpdate = async () => {
    if (!serverUrl) return;
    setUpdate({ state: 'running' });
    try {
      let version: string;
      try {
        const h = await api.health();
        onHealth(h);
        version = h.version;
      } catch (err) {
        // A revoked token still lets us read the public subset, which carries the version.
        if (!(err instanceof ApiError && err.code === 'unauthorized')) throw err;
        version = (await api.probe(serverUrl)).version;
      }
      setUpdate({ state: 'done', at: Date.now(), verdict: compareDaemonAndApp(version) });
    } catch (err) {
      setUpdate({ state: 'error', message: probeFailureMessage(err) });
    }
  };

  return (
    <View style={{ padding: t.spacing.lg, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          title="Test connection"
          size="sm"
          variant="secondary"
          icon="pulse-outline"
          onPress={() => void onTest()}
          loading={test.state === 'running'}
          disabled={!serverUrl}
          full
          style={{ flex: 1 }}
        />
        <Button
          title="Check version"
          size="sm"
          variant="secondary"
          icon="cloud-download-outline"
          onPress={() => void onCheckUpdate()}
          loading={update.state === 'running'}
          disabled={!serverUrl}
          full
          style={{ flex: 1 }}
        />
      </View>

      {test.state === 'done' ? (
        <View
          style={{ gap: 8, backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.md, padding: 12 }}
          accessibilityLabel="Connection test result"
        >
          <ResultRow
            icon={test.reachable ? 'checkmark-circle' : 'close-circle'}
            tone={test.reachable ? 'success' : 'danger'}
            text={
              test.reachable
                ? `Daemon reachable in ${test.latencyMs ?? '?'} ms — ${test.serverName ?? 'unnamed'} v${test.version ?? '?'}`
                : `Daemon unreachable. ${test.message ?? ''}`
            }
          />
          {test.reachable ? (
            <ResultRow
              icon={test.tokenOk === true ? 'key' : test.tokenOk === false ? 'key-outline' : 'help-circle-outline'}
              tone={test.tokenOk === true ? 'success' : test.tokenOk === false ? 'danger' : 'warning'}
              text={test.tokenOk === true ? 'Device token accepted' : (test.message ?? 'Token could not be checked')}
              action={test.tokenOk === false ? { title: 'Pair again', onPress: () => router.push('/(auth)/pair') } : undefined}
            />
          ) : null}
          {test.reachable && test.tokenOk ? (
            <ResultRow
              icon={wsState === 'open' ? 'radio' : 'radio-outline'}
              tone={wsState === 'open' ? 'success' : wsState === 'connecting' || wsState === 'reconnecting' ? 'warning' : 'danger'}
              text={`Live connection: ${connectionLabel(wsState, wsDetail)}`}
              action={wsState !== 'open' ? { title: 'Reconnect', onPress: restart } : undefined}
            />
          ) : null}
          <T variant="caption" color="textFaint">
            Tested {relativeTime(test.at, now)}
          </T>
        </View>
      ) : null}

      {update.state === 'done' ? <VerdictCard verdict={update.verdict} at={update.at} now={now} /> : null}
      {update.state === 'error' ? (
        <View style={{ gap: 4, backgroundColor: t.colors.dangerSoft, borderRadius: t.radius.md, padding: 12 }}>
          <ResultRow icon="close-circle" tone="danger" text={`Couldn't read the daemon version. ${update.message}`} />
        </View>
      ) : null}
    </View>
  );
}

function VerdictCard({ verdict, at, now }: { verdict: UpdateVerdict; at: number; now: number }) {
  const t = useTheme();
  const tone: 'success' | 'warning' | 'info' | 'neutral' =
    verdict.kind === 'match'
      ? 'success'
      : verdict.kind === 'daemon_behind'
        ? 'warning'
        : verdict.kind === 'app_behind'
          ? 'info'
          : 'neutral';
  const colors = channelToneColors(tone, t);
  const icon: IconName =
    verdict.kind === 'match' ? 'checkmark-done-outline' : verdict.kind === 'unknown' ? 'help-circle-outline' : 'arrow-up-circle-outline';
  return (
    <View style={{ gap: 8, backgroundColor: colors.bg, borderRadius: t.radius.md, padding: 12 }} accessibilityLabel="Update check result">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <Ionicons name={icon} size={18} color={colors.fg} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="bodySmall" weight="600" style={{ color: colors.fg }}>
            {verdict.title}
          </T>
          <T variant="bodySmall" color="textMuted">
            {verdict.detail}
          </T>
        </View>
      </View>
      {verdict.kind === 'daemon_behind' ? <CodeBlock code={verdict.command} /> : null}
      <T variant="caption" color="textFaint">
        Daemon v{verdict.daemon} · app v{verdict.app} · checked {relativeTime(at, now)}
      </T>
    </View>
  );
}

function ResultRow({
  icon,
  tone,
  text,
  action,
}: {
  icon: IconName;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  text: string;
  action?: { title: string; onPress: () => void };
}) {
  const t = useTheme();
  const color = { success: t.colors.success, warning: t.colors.warning, danger: t.colors.danger, neutral: t.colors.textMuted }[tone];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Ionicons name={icon} size={16} color={color} />
      <T variant="bodySmall" style={{ flex: 1 }}>
        {text}
      </T>
      {action ? <Button title={action.title} size="sm" variant="secondary" onPress={action.onPress} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
function AgentsSection({ health }: { health: HealthResponse | undefined }) {
  const t = useTheme();
  if (!health || health.agents.length === 0) return null;
  return (
    <>
      <SectionHeader title="Agents" />
      <Card padded={false} style={{ marginHorizontal: t.spacing.lg }}>
        {health.agents.map((a, i) => {
          const chip = agentStateChip(a.state, t);
          return (
            <View key={a.id}>
              {i > 0 ? <Divider inset={t.spacing.lg} /> : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingVertical: 12, gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T variant="body" weight="500">
                    {a.id}
                  </T>
                  <T variant="caption" color="textMuted" numberOfLines={2}>
                    {a.detail ? a.detail : a.sessions === 1 ? '1 session' : `${a.sessions} sessions`}
                  </T>
                </View>
                <Chip label={chip.label} bg={chip.bg} fg={chip.fg} />
              </View>
            </View>
          );
        })}
      </Card>
    </>
  );
}

function agentStateChip(state: HealthResponse['agents'][number]['state'], t: Theme): { label: string; bg: string; fg: string } {
  switch (state) {
    case 'ready':
      return { label: 'Ready', bg: t.colors.successSoft, fg: t.colors.success };
    case 'starting':
      return { label: 'Starting', bg: t.colors.infoSoft, fg: t.colors.info };
    case 'error':
      return { label: 'Error', bg: t.colors.dangerSoft, fg: t.colors.danger };
    default:
      return { label: 'Stopped', bg: t.colors.surfaceAlt, fg: t.colors.textMuted };
  }
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------
function DeviceSection() {
  const t = useTheme();
  const deviceName = useSettings((s) => s.deviceName);
  const deviceId = useSettings((s) => s.deviceId);
  return (
    <>
      <SectionHeader title="This device" />
      <Card padded={false} style={{ marginHorizontal: t.spacing.lg }}>
        <KeyValue label="Name" value={deviceName ?? '—'} />
        <Divider inset={t.spacing.lg} />
        <KeyValue label="Device id" value={deviceId ?? '—'} mono onPress={deviceId ? () => void copy('Device id', deviceId) : undefined} />
        <Divider inset={t.spacing.lg} />
        <KeyValue label="Platform" value={platformDescription()} />
      </Card>
      <T variant="caption" color="textFaint" style={{ paddingHorizontal: t.spacing.lg + 4, marginTop: 8 }}>
        Revoke this device from the daemon with `mide devices --revoke {deviceId ? truncate(deviceId, 8) : '<id>'}`.
      </T>
    </>
  );
}

function platformDescription(): string {
  if (Platform.OS === 'web') return isStandaloneWeb() ? 'Web · installed app' : 'Web · browser tab';
  const v = Platform.Version;
  return `${Platform.OS === 'ios' ? 'iOS' : Platform.OS}${v ? ` ${v}` : ''}`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function NotificationsSection() {
  const t = useTheme();
  const [testing, setTesting] = useState(false);
  const [showNtfy, setShowNtfy] = useState(false);
  const paired = useSettings((s) => isPaired(s));
  // a channel counts only when this device (its current id) registered it with the daemon
  const hasAnyChannel = useSettings((s) => !!s.expoPushToken || !!s.webPushEndpoint || (!!s.ntfyTopic && s.ntfyDeviceId === s.deviceId));

  const sendTest = async () => {
    setTesting(true);
    try {
      await api.pushTest();
      toast.success('Test notification sent — it should arrive within a few seconds.');
    } catch (err) {
      // the daemon knows of no channel for this device (local state disagreed): informational, not a failure
      if (err instanceof ApiError && err.serverCode === 'no_subscriptions') toast.info('Register a notification channel above first.');
      else toast.error(`Test failed: ${truncate(errorMessage(err), 140)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SectionHeader title="Notifications" />
      <T variant="bodySmall" color="textMuted" style={{ paddingHorizontal: t.spacing.lg + 4, marginBottom: 10 }}>
        Step away without losing your place. Get a notification when an agent needs you or finishes work.
      </T>
      <Card padded={false} style={{ marginHorizontal: t.spacing.lg }}>
        {isWeb ? <WebPushRow /> : <ExpoPushRow />}
        <Divider inset={t.spacing.lg} />
        <Tap
          onPress={() => setShowNtfy((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Set up ntfy notifications"
          accessibilityState={{ expanded: showNtfy }}
          style={{ padding: 20, minHeight: 56, flexDirection: 'row', gap: 10, alignItems: 'center' }}
        >
          <Ionicons name="chatbox-ellipses-outline" size={18} color={t.colors.textMuted} />
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="bodySmall" weight="600">
              Use the ntfy app
            </T>
            <T variant="caption" color="textMuted">
              An alternative for any device.
            </T>
          </View>
          <Ionicons name={showNtfy ? 'chevron-up' : 'chevron-down'} size={16} color={t.colors.textMuted} />
        </Tap>
        {showNtfy ? <NtfyRows /> : null}
        <Divider inset={t.spacing.lg} />
        <View style={{ padding: t.spacing.lg, gap: 10 }}>
          <Button
            title="Send test notification"
            variant="secondary"
            icon="paper-plane-outline"
            onPress={() => void sendTest()}
            loading={testing}
            disabled={!paired || !hasAnyChannel}
            full
          />
          {paired && !hasAnyChannel ? (
            <T variant="caption" color="textFaint" align="center">
              Register a channel above first.
            </T>
          ) : null}
          <View style={{ gap: 4 }}>
            <T variant="caption" color="textMuted" weight="600">
              When you get notified
            </T>
            <Trigger text="An agent needs approval or has a question." />
            <Trigger text="Work finishes after 20 seconds or uses a tool." />
            <Trigger text="Something goes wrong in a session." />
            <T variant="caption" color="textFaint" style={{ marginTop: 2 }}>
              Repeats within 10 s are merged. Tapping a notification opens the session.
            </T>
          </View>
        </View>
      </Card>
    </>
  );
}

function Trigger({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
      <Ionicons name="ellipse" size={5} color={t.colors.textFaint} style={{ marginTop: 6 }} />
      <T variant="caption" color="textMuted" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

/** Icon + title + status chip; every channel row starts with one. */
function ChannelHeader({ icon, title, status }: { icon: IconName; title: string; status: ChannelStatus }) {
  const t = useTheme();
  const colors = channelToneColors(status.tone, t);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: t.colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={17} color={t.colors.textMuted} />
      </View>
      <T variant="body" weight="600" style={{ flex: 1 }}>
        {title}
      </T>
      <Chip label={status.label} bg={colors.bg} fg={colors.fg} />
    </View>
  );
}

/** Native: Expo push token (APNs/FCM through Expo's push service). */
function ExpoPushRow() {
  const t = useTheme();
  const token = useSettings((s) => s.expoPushToken);
  const { status, refresh } = useExpoPushStatus();
  const [busy, setBusy] = useState(false);
  const described = describeExpoPushStatus(status);

  const onEnable = async () => {
    setBusy(true);
    try {
      const r = await registerExpoPush();
      if (r.ok) toast.success('Push notifications enabled on this device');
      else toast.error(r.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <View
      style={{ paddingHorizontal: t.spacing.lg, paddingVertical: 14, gap: 10 }}
      accessibilityLabel={`Push notifications: ${described.label}`}
    >
      <ChannelHeader icon="phone-portrait-outline" title="Push notifications" status={described} />
      <T variant="caption" color="textMuted">
        {described.detail}
      </T>
      {described.action ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {described.action === 'settings' ? (
            <Button
              title="Open Settings"
              size="sm"
              variant="secondary"
              icon="settings-outline"
              onPress={() => void openSystemNotificationSettings()}
            />
          ) : (
            <Button
              title={described.action === 'reregister' ? 'Re-register' : 'Enable'}
              size="sm"
              variant={described.action === 'reregister' ? 'secondary' : 'primary'}
              icon="notifications-outline"
              loading={busy}
              onPress={() => void onEnable()}
            />
          )}
          {token ? (
            <Button
              title="Forget token"
              size="sm"
              variant="ghost"
              onPress={() => {
                clearExpoPush();
                toast.info('Token forgotten on this device. Revoke the device to stop pushes immediately.');
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Web: VAPID Web Push for the installed PWA. */
function WebPushRow() {
  const t = useTheme();
  const endpoint = useSettings((s) => s.webPushEndpoint);
  const [status, setStatus] = useState<WebPushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [manualKey, setManualKey] = useState('');

  const refresh = useCallback(() => {
    if (!isWeb) return;
    getWebPushStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    if (!isWeb) return;
    loadManualVapidKey()
      .then((k) => {
        if (k) setManualKey(k);
      })
      .catch(() => {});
  }, [endpoint, refresh]);

  const described = describeWebPushStatus(status);

  const onEnable = async () => {
    setBusy(true);
    try {
      const r = await subscribeWebPush({ vapidPublicKey: manualKey.trim() || null });
      if (r.ok) {
        setNeedsKey(false);
        toast.success('Web Push enabled for this installed app');
      } else {
        if (r.reason === 'no_vapid') setNeedsKey(true);
        toast.error(r.message);
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onDisable = async () => {
    setBusy(true);
    try {
      await unsubscribeWebPush();
      toast.info('Web Push disabled');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, paddingVertical: 14, gap: 10 }} accessibilityLabel={`Web Push: ${described.label}`}>
      <ChannelHeader icon="globe-outline" title="Web Push" status={described} />
      <T variant="caption" color="textMuted">
        {described.detail}
      </T>
      {described.action === 'enable' || described.action === 'disable' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            title={described.action === 'disable' ? 'Disable' : 'Enable'}
            size="sm"
            variant={described.action === 'disable' ? 'secondary' : 'primary'}
            icon="notifications-outline"
            loading={busy}
            onPress={() => void (described.action === 'disable' ? onDisable() : onEnable())}
          />
        </View>
      ) : null}
      {needsKey ? (
        <View style={{ gap: 8 }}>
          <TextField
            label="VAPID public key"
            mono
            value={manualKey}
            onChangeText={setManualKey}
            placeholder="BH… (base64url)"
            autoCorrect={false}
            hint="Normally the daemon publishes this at /api/push/vapid (run `mide vapid` once). Paste it here only if your daemon predates that route."
          />
          <Button
            title="Retry with this key"
            size="sm"
            variant="secondary"
            onPress={() => void onEnable()}
            loading={busy}
            disabled={!manualKey.trim()}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Everyone: ntfy topic (works today with the ntfy iOS app, no Apple account needed). */
function NtfyRows() {
  const t = useTheme();
  const savedTopic = useSettings((s) => s.ntfyTopic);
  const savedServer = useSettings((s) => s.ntfyServer);
  // registered means: by this device id — pairing again mints a new id the daemon has no ntfy row for
  const registeredHere = useSettings((s) => !!s.ntfyTopic && s.ntfyDeviceId === s.deviceId);
  const paired = useSettings((s) => isPaired(s));
  const [topic, setTopic] = useState(savedTopic);
  const [server, setServer] = useState(savedServer || 'https://ntfy.sh');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = topic.trim() !== savedTopic || normalizeServerUrl(server) !== normalizeServerUrl(savedServer || 'https://ntfy.sh');
  const registered = registeredHere && !dirty;
  const status: ChannelStatus = registered
    ? {
        label: 'Registered',
        tone: 'success',
        detail: `The daemon posts to “${savedTopic}”. Subscribe to that topic in the ntfy app.`,
        action: null,
      }
    : savedTopic && !dirty
      ? {
          label: 'Not registered',
          tone: 'warning',
          detail: 'This device was paired again since the topic was saved; register it with the daemon once more.',
          action: null,
        }
      : savedTopic
        ? { label: 'Unsaved changes', tone: 'warning', detail: 'Save to update the topic the daemon posts to.', action: null }
        : {
            label: 'Not set',
            tone: 'neutral',
            detail:
              'Free relay through the ntfy app — works in every build, no Apple account needed. Treat the topic like a password: anyone who knows it can read your notifications.',
            action: null,
          };

  const onSave = async () => {
    const tp = topic.trim();
    const sv = normalizeServerUrl(server.trim() || 'https://ntfy.sh');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tp)) {
      setError('Topic: letters, digits, dash and underscore only (max 64).');
      return;
    }
    if (!/^https?:\/\/[^/\s]+/.test(sv)) {
      setError('Server must be an http(s) URL, e.g. https://ntfy.sh');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.pushRegister({ kind: 'ntfy', topic: tp, server: sv });
      useSettings.getState().setNtfy(tp, sv);
      toast.success('ntfy topic registered with the daemon');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, paddingVertical: 14, gap: 10 }} accessibilityLabel={`ntfy: ${status.label}`}>
      <ChannelHeader icon="chatbox-ellipses-outline" title="ntfy" status={status} />
      <T variant="caption" color="textMuted">
        {status.detail}
      </T>
      <TextField
        label="Topic"
        mono
        value={topic}
        onChangeText={(v) => {
          setTopic(v);
          if (error) setError(null);
        }}
        placeholder="mide-…"
        autoCorrect={false}
        maxLength={64}
        right={
          <IconButton
            name="shuffle-outline"
            label="Generate a random topic"
            size={18}
            onPress={() => setTopic(`mide-${randomToken(20)}`)}
          />
        }
      />
      <TextField
        label="Server"
        mono
        value={server}
        onChangeText={(v) => {
          setServer(v);
          if (error) setError(null);
        }}
        placeholder="https://ntfy.sh"
        keyboardType="url"
        autoCorrect={false}
        error={error}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Button
          title={
            registered ? 'Re-register' : savedTopic && !dirty ? 'Register again' : savedTopic ? 'Update registration' : 'Save & register'
          }
          size="sm"
          icon={registered ? 'refresh' : 'notifications-outline'}
          variant={registered ? 'secondary' : 'primary'}
          onPress={() => void onSave()}
          loading={busy}
          disabled={!paired || !topic.trim()}
        />
        {registered ? (
          <T variant="caption" color="textMuted" style={{ flex: 1 }} numberOfLines={2}>
            Install ntfy from the App Store and subscribe to “{savedTopic}”.
          </T>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------
function AppearanceSection() {
  const t = useTheme();
  const [displayDetails, setDisplayDetails] = useState(false);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const fontSize = useSettings((s) => s.terminalFontSize);
  const setFontSize = useSettings((s) => s.setTerminalFontSize);
  const safeArea = useSettings((s) => s.safeArea);
  const setSafeArea = useSettings((s) => s.setSafeArea);
  const viewport = Platform.OS === 'web' ? measureWebViewport(safeArea) : null;
  const system = useColorScheme();
  const options: { key: ThemePreference; label: string }[] = [
    { key: 'system', label: 'System' },
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
  ];
  const effective = theme === 'system' ? (system === 'light' ? 'light' : 'dark') : theme;
  return (
    <>
      <SectionHeader title="Choose your atmosphere" />
      <Card style={{ marginHorizontal: t.spacing.lg, gap: 14 }}>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name={effective === 'dark' ? 'moon-outline' : 'sunny-outline'} size={16} color={t.colors.textMuted} />
            <T variant="label" style={{ flex: 1 }}>
              Theme
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {options.map((option) => (
              <ThemePreview
                key={option.key}
                preference={option.key}
                label={option.label}
                selected={theme === option.key}
                effective={effective}
                onPress={() => setTheme(option.key)}
              />
            ))}
          </View>
          <T variant="caption" color="textFaint">
            {theme === 'system'
              ? `Follows the ${Platform.OS === 'web' ? 'browser' : 'device'} setting · currently ${effective}`
              : `Always ${effective}, whatever the ${Platform.OS === 'web' ? 'browser' : 'device'} uses`}
          </T>
        </View>
        {viewport ? (
          <Tap
            onPress={() => setDisplayDetails((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Display adjustments"
            accessibilityState={{ expanded: displayDetails }}
            style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
          >
            <Ionicons name="phone-portrait-outline" size={17} color={t.colors.textMuted} />
            <T variant="bodySmall" style={{ flex: 1 }}>
              Display adjustments
            </T>
            <Ionicons name={displayDetails ? 'chevron-up' : 'chevron-down'} size={15} color={t.colors.textMuted} />
          </Tap>
        ) : null}
        {viewport && displayDetails ? (
          <>
            <Divider />
            <View style={{ gap: 8 }}>
              <T variant="label">Screen edges</T>
              <Segmented<SafeAreaMode>
                options={[
                  { key: 'auto', label: 'Auto' },
                  { key: 'none', label: 'None' },
                  { key: 'top', label: 'Top' },
                  { key: 'both', label: 'Both' },
                ]}
                value={safeArea}
                onChange={setSafeArea}
              />
              <T variant="caption" color="textFaint">
                {safeArea === 'auto'
                  ? `Measured: iOS keeps ${viewport.reserved} pt of the screen; padding ${viewport.applied.top} pt top, ${viewport.applied.bottom} pt bottom.`
                  : `Forced: ${viewport.applied.top} pt top, ${viewport.applied.bottom} pt bottom. Use if the header hides under the status bar or a gap shows below.`}
              </T>
            </View>
          </>
        ) : null}
        <Divider />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T variant="body" weight="500">
              Terminal font size
            </T>
            <T variant="caption" color="textMuted">
              Applies to the Terminal tab
            </T>
          </View>
          <IconButton
            name="remove"
            label="Smaller"
            size={18}
            filled
            disabled={fontSize <= 10}
            onPress={() => setFontSize(Math.max(10, fontSize - 1))}
          />
          <T variant="mono" style={{ width: 28, textAlign: 'center' }}>
            {fontSize}
          </T>
          <IconButton
            name="add"
            label="Larger"
            size={18}
            filled
            disabled={fontSize >= 22}
            onPress={() => setFontSize(Math.min(22, fontSize + 1))}
          />
        </View>
      </Card>
    </>
  );
}

function ThemePreview({
  preference,
  label,
  selected,
  effective,
  onPress,
}: {
  preference: ThemePreference;
  label: string;
  selected: boolean;
  effective: 'light' | 'dark';
  onPress: () => void;
}) {
  const t = useTheme();
  const preview = themes[preference === 'system' ? effective : preference];
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} theme`}
      accessibilityState={{ selected }}
      pressedColor={null}
      style={{ flex: 1, minWidth: 0, gap: 10 }}
    >
      <View
        style={{
          height: 90,
          borderRadius: 12,
          padding: 9,
          gap: 7,
          backgroundColor: preview.colors.bg,
          borderWidth: 2,
          borderColor: selected ? t.colors.accent : t.colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: preview.colors.textFaint }} />
          ))}
        </View>
        <View style={{ flex: 1, flexDirection: 'row', gap: 5 }}>
          <View style={{ width: 16, backgroundColor: preview.colors.surfaceAlt, borderRadius: 3 }} />
          <View style={{ flex: 1, gap: 5, paddingTop: 3 }}>
            <View style={{ width: '80%', height: 4, backgroundColor: preview.colors.textMuted, borderRadius: 2 }} />
            <View style={{ width: '60%', height: 4, backgroundColor: preview.colors.borderStrong, borderRadius: 2 }} />
            <View style={{ height: 15, marginTop: 5, backgroundColor: preview.colors.accentSoft, borderRadius: 3 }} />
          </View>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingBottom: 6 }}>
        <T variant="bodySmall" color={selected ? 'accent' : 'textMuted'} weight={selected ? '600' : '400'}>
          {label}
        </T>
        {selected ? <Ionicons name="checkmark-circle" size={13} color={t.colors.accent} /> : null}
      </View>
    </Tap>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------
function AboutSection({ health }: { health: HealthResponse | undefined }) {
  const t = useTheme();
  const info = buildInfo();
  const serverUrl = useSettings((s) => s.serverUrl);
  const envLabel =
    { web: isStandaloneWeb() ? 'installed web app' : 'browser', bare: 'native build', standalone: 'native build', storeClient: 'Expo Go' }[
      info.environment
    ] ?? info.environment;

  const copyDiagnostics = async () => {
    const s = useSettings.getState();
    const c = useConnection.getState();
    const report = {
      generatedAt: new Date().toISOString(),
      app: { ...info, platform: platformDescription(), protocol: PROTOCOL_VERSION },
      daemon: health
        ? {
            name: health.serverName,
            version: health.version,
            uptimeSec: health.uptimeSec,
            agents: health.agents.map((a) => ({ id: a.id, state: a.state, sessions: a.sessions })),
            sessions: health.sessions,
          }
        : { url: serverUrl ? hostOf(serverUrl) : null, note: 'health not loaded' },
      connection: { state: c.state, detail: c.detail, lastOpenAt: c.lastOpenAt ? new Date(c.lastOpenAt).toISOString() : null },
      notifications: { expoPush: !!s.expoPushToken, webPush: !!s.webPushEndpoint, ntfy: !!s.ntfyTopic },
      viewport: measureWebViewport(s.safeArea),
    };
    await copy('Diagnostics', JSON.stringify(report, null, 2));
  };

  // web only: the numbers behind the safe-area decision (null on native)
  const viewport = measureWebViewport(useSettings((s) => s.safeArea));

  return (
    <>
      <SectionHeader title="About" />
      <Card padded={false} style={{ marginHorizontal: t.spacing.lg }}>
        <KeyValue label="App" value={`Mobile IDE ${info.version}${info.build ? ` (build ${info.build})` : ''}`} />
        <Divider inset={t.spacing.lg} />
        <KeyValue
          label="Runtime"
          value={`${info.sdk ? `Expo SDK ${info.sdk}` : 'Expo'} · ${envLabel}${info.runtime ? ` · runtime ${info.runtime}` : ''}`}
        />
        <Divider inset={t.spacing.lg} />
        <KeyValue label="Protocol" value={`v${PROTOCOL_VERSION} over WebSocket · REST /api`} />
        <Divider inset={t.spacing.lg} />
        <KeyValue label="Daemon" value={health ? `${health.serverName} v${health.version}` : serverUrl ? hostOf(serverUrl) : '—'} />
        {viewport ? (
          <>
            <Divider inset={t.spacing.lg} />
            <KeyValue
              label="Viewport"
              mono
              value={`${viewport.innerWidth}×${viewport.innerHeight} of ${viewport.screenWidth}×${viewport.screenHeight}${viewport.standalone ? ' · standalone' : ' · browser tab'}`}
            />
            <Divider inset={t.spacing.lg} />
            <KeyValue
              label="Safe area"
              mono
              value={`env ${viewport.envTop}/${viewport.envBottom} · reserved ${viewport.reserved} · ${viewport.mode} · padding ${viewport.applied.top}/${viewport.applied.bottom}`}
            />
          </>
        ) : null}
        <Divider inset={t.spacing.lg} />
        <View style={{ padding: t.spacing.lg, gap: 10 }}>
          <T variant="caption" color="textMuted">
            Drives Claude Code, Codex, OpenCode and any ACP agent from your phone through a daemon on your own machine. Sessions, events and
            approvals live on the daemon; this app is a resumable view. Setup and operations: docs/RUNBOOK.md in the repository.
          </T>
          <Button title="Copy diagnostics" size="sm" variant="secondary" icon="bug-outline" onPress={() => void copyDiagnostics()} />
        </View>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------
function DangerSection() {
  const t = useTheme();
  const serverName = useSettings((s) => s.serverName);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const forget = async () => {
    setBusy(true);
    try {
      // Order matters: drop the credentials first so the connection bootstrap (which reacts to every
      // settings change) does not briefly reopen a socket while we tear down.
      useConnection.getState().stop();
      useSettings.getState().forgetServer();
      if (isWeb) await unsubscribeWebPush().catch(() => {});
      useSessions.getState().reset();
      useProjects.setState({ projects: [], loaded: false, error: null, selectedRoot: null });
      setConfirm(false);
      toast.info('Server forgotten. Pair again whenever you like.');
      router.replace('/(auth)/pair');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader title="Disconnect this device" />
      <Card style={{ marginHorizontal: t.spacing.lg, gap: 10 }}>
        <T variant="bodySmall" color="textMuted">
          Forget this connection on this device. Your sessions keep running on your computer; reconnect whenever you like.
        </T>
        <Button title="Forget this server" variant="dangerSoft" icon="log-out-outline" onPress={() => setConfirm(true)} />
      </Card>
      <Sheet
        visible={confirm}
        onClose={() => setConfirm(false)}
        title="Forget this server?"
        subtitle={serverName ?? undefined}
        footer={
          <View style={{ gap: 8 }}>
            <Button title="Forget server" variant="danger" onPress={() => void forget()} loading={busy} full />
            <Button title="Cancel" variant="secondary" onPress={() => setConfirm(false)} disabled={busy} full />
          </View>
        }
      >
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 6 }}>
          <Ionicons name="warning-outline" size={20} color={t.colors.warning} style={{ marginTop: 2 }} />
          <T variant="bodySmall" style={{ flex: 1 }}>
            You'll need a fresh code from `mide pair` to reconnect. The device stays listed in `mide devices` until you revoke it there.
          </T>
        </View>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function copy(label: string, value: string): Promise<void> {
  if (await copyText(value)) toast.success(`${label} copied`);
  else toast.error(`Couldn't copy ${label.toLowerCase()}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, 32);
  }
}

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function randomToken(len: number): string {
  const out: string[] = [];
  const cryptoObj = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = new Uint8Array(len);
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < len; i++) out.push(TOKEN_ALPHABET[(bytes[i] ?? 0) % TOKEN_ALPHABET.length] ?? 'x');
  return out.join('');
}
