/**
 * Pairing: point the app at a daemon and redeem a one-time code from `mide pair`.
 * Prefills from `mobileide://pair?server=&code=`, `/pair?server=…#code` (web), a pasted link/code,
 * a scanned QR (native builds with expo-camera) or a recently used server.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from 'react-native';
import { QrScanSheet, qrScanSupported } from '../../src/components/pair/QrScanSheet';
import { BrandMark, Button, Card, Chip, CodeBlock, Screen, T, Tap, TextField } from '../../src/components/ui';
import { haptic } from '../../src/lib/haptics';
import {
  cleanCode,
  clearLocationHash,
  first,
  normalizeCodeInput,
  pairParamsFromLocation,
  parsePairLink,
  serverUrlFromLocation,
  type PairLinkParams,
} from '../../src/lib/links';
import { KEYBOARD_DISMISS_ON_DRAG, defaultDeviceName, isIosSafariWeb, isStandaloneWeb, isWeb } from '../../src/lib/platform';
import {
  forgetKnownServer,
  knownServerLabel,
  rememberServer,
  touchKnownServer,
  useServerHistory,
  type KnownServer,
} from '../../src/lib/serverHistory';
import { api, ApiError, errorMessage } from '../../src/state/api';
import { isPaired, normalizeServerUrl, useSettings } from '../../src/state/settings';
import { toast } from '../../src/state/toast';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useWebKeyboardInset } from '../../src/components/chat/useKeyboardInset';

type Probe =
  { state: 'idle' } | { state: 'checking' } | { state: 'ok'; serverName: string; version: string } | { state: 'fail'; message: string };

const CODE_HINT = 'The one-time code from your computer. Spaces and dashes are okay.';

export default function PairScreen() {
  const t = useTheme();
  // iOS Safari / the installed PWA shrink only the visual viewport: pad by the covered band so the fields and Pair button stay reachable
  const webInset = useWebKeyboardInset();
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const incomingUrl = Linking.useURL();
  const savedUrl = useSettings((s) => s.serverUrl);
  const savedServerName = useSettings((s) => s.serverName);
  const savedDeviceName = useSettings((s) => s.deviceName);
  const alreadyPaired = useSettings((s) => isPaired(s));
  const historyHydrated = useServerHistory((s) => s.hydrated);

  const [serverUrl, setServerUrl] = useState(() => savedUrl ?? serverUrlFromLocation() ?? '');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(() => savedDeviceName ?? defaultDeviceName());
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [showDeviceOptions, setShowDeviceOptions] = useState(false);
  const [showSetupHelp, setShowSetupHelp] = useState(false);

  const codeRef = useRef<TextInput>(null);
  const probeSeq = useRef(0);
  const lastProbed = useRef('');
  const appliedLink = useRef('');

  const runProbe = useCallback(async (url: string) => {
    const target = normalizeServerUrl(url);
    if (!target) {
      setProbe({ state: 'idle' });
      return;
    }
    lastProbed.current = target;
    const my = ++probeSeq.current;
    setProbe({ state: 'checking' });
    try {
      const h = await api.probe(target);
      if (my !== probeSeq.current) return;
      setProbe({ state: 'ok', serverName: h.serverName, version: h.version });
      touchKnownServer(target, { name: h.serverName, version: h.version });
    } catch (err) {
      if (my !== probeSeq.current) return;
      setProbe({ state: 'fail', message: friendlyProbeError(err) });
    }
  }, []);

  /** Redeem a code. Values are passed explicitly so a scan can pair without waiting for state to settle. */
  const pairWith = useCallback(async (input: { url: string; code: string; name: string }) => {
    const url = normalizeServerUrl(input.url);
    const normalizedCode = normalizeCodeInput(input.code);
    const name = input.name.trim().slice(0, 80);
    if (!url || !/^https?:\/\/[^/\s]+/i.test(url)) {
      setPairError('Enter the daemon URL, e.g. https://laptop.your-tailnet.ts.net');
      return;
    }
    if (normalizedCode.length < 4) {
      setPairError('Enter the pairing code printed by `mide pair`.');
      return;
    }
    if (!name) {
      setPairError('Give this device a name so you can recognise it in `mide devices`.');
      return;
    }
    setPairing(true);
    setPairError(null);
    try {
      const res = await api.pair(url, { code: normalizedCode, deviceName: name, platform: platformLabel() });
      useSettings
        .getState()
        .setPaired({ serverUrl: url, token: res.token, deviceId: res.deviceId, serverName: res.serverName, deviceName: name });
      rememberServer({ url, name: res.serverName });
      clearLocationHash();
      void haptic.success();
      toast.success(`Paired with ${res.serverName}`);
      // `index` redirects to the tabs once the auth guard sees the new token.
      router.replace('/');
    } catch (err) {
      void haptic.error();
      setPairError(friendlyPairError(err));
    } finally {
      setPairing(false);
    }
  }, []);

  /** Fill the form from any pairing link (deep link, pasted text, scanned QR). */
  const applyLink = useCallback(
    (parsed: PairLinkParams, opts: { autoPair?: boolean } = {}) => {
      setPairError(null);
      if (parsed.server) {
        setServerUrl(parsed.server);
        void runProbe(parsed.server);
      }
      if (parsed.code) setCode(parsed.code);
      const url = parsed.server ?? serverUrl;
      if (opts.autoPair && parsed.code && normalizeServerUrl(url) && deviceName.trim()) {
        void pairWith({ url, code: parsed.code, name: deviceName });
      } else if (!parsed.code) {
        setTimeout(() => codeRef.current?.focus(), 50);
      }
    },
    [deviceName, pairWith, runProbe, serverUrl],
  );

  // Prefill from a deep link, query params or the URL fragment — once per distinct link.
  useEffect(() => {
    // Expo Router exposes a URL fragment (`/pair#CODE`, what `mide pair` prints) as the `#` param.
    const fromParams: PairLinkParams = {
      server: first(params.server)?.trim() || undefined,
      code: cleanCode(first(params.code)) ?? cleanCode(first(params['#'])),
    };
    const fromUrl = parsePairLink(incomingUrl);
    const fromLocation = pairParamsFromLocation();
    // On the web `incomingUrl` is just the page location. A bare `/pair` visit only tells us the page's
    // origin — a saved daemon URL beats that guess. A link that carries a code came from the daemon, so
    // its origin is trustworthy.
    const anyCode = fromParams.code ?? fromUrl.code ?? fromLocation.code;
    const linkServer = (p: PairLinkParams) => (p.serverInferred && !anyCode && savedUrl ? undefined : p.server);
    const merged: PairLinkParams = {
      server: fromParams.server ?? linkServer(fromUrl) ?? linkServer(fromLocation),
      code: anyCode,
    };
    if (!merged.server && !merged.code) return;
    const sig = `${merged.server ?? ''}|${merged.code ?? ''}`;
    if (sig === appliedLink.current) return;
    appliedLink.current = sig;
    setPairError(null);
    if (merged.server) {
      setServerUrl(merged.server);
      void runProbe(merged.server);
    }
    if (merged.code) setCode(merged.code);

    if (merged.code) clearLocationHash(); // burnt once used; don't retry it on reload
  }, [params.server, params.code, params['#'], incomingUrl, savedUrl, runProbe]);

  // Probe an existing server once so a returning user sees its state immediately.
  useEffect(() => {
    if (serverUrl && !lastProbed.current) void runProbe(serverUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Devices paired before server history existed: seed the list with the current daemon.
  useEffect(() => {
    if (!historyHydrated || !alreadyPaired || !savedUrl) return;
    const key = normalizeServerUrl(savedUrl);
    if (!useServerHistory.getState().servers.some((s) => s.url === key)) rememberServer({ url: savedUrl, name: savedServerName });
  }, [historyHydrated, alreadyPaired, savedUrl, savedServerName]);

  const onServerBlur = () => {
    const target = normalizeServerUrl(serverUrl);
    if (target && target !== lastProbed.current) void runProbe(serverUrl);
  };

  const onCodeChange = (text: string) => {
    // A pasted pairing link fills both fields.
    if (/[:/?#]/.test(text)) {
      const parsed = parsePairLink(text);
      if (parsed.code || parsed.server) {
        applyLink(parsed);
        return;
      }
    }
    setCode(text.toUpperCase());
    if (pairError) setPairError(null);
  };

  const onPaste = async () => {
    setPasting(true);
    let text = '';
    try {
      text = (await Clipboard.getStringAsync()).trim();
    } catch (err) {
      console.warn('[pair] clipboard read failed', err);
      toast.error(isWeb ? 'The browser blocked clipboard access. Paste into the code field instead.' : "Couldn't read the clipboard.");
      setPasting(false);
      return;
    }
    setPasting(false);
    if (!text) {
      toast.info('The clipboard is empty. Copy the link or code that `mide pair` printed.');
      return;
    }
    // A link is self-describing; bare text must look like a code (daemon codes are 8 chars) so a stray
    // sentence on the clipboard is not mistaken for one.
    const isLink = /[:/?#]/.test(text);
    const parsed = isLink ? parsePairLink(text) : looksLikeBareCode(text) ? parsePairLink(text) : {};
    if (!parsed.code && !parsed.server) {
      toast.error("The clipboard doesn't contain a pairing link or code.");
      return;
    }
    void haptic.light();
    applyLink(parsed);
    toast.success(
      parsed.code && parsed.server ? 'Server and code filled in — tap Connect' : parsed.code ? 'Code filled in' : 'Server URL filled in',
    );
  };

  const onPickServer = (s: KnownServer) => {
    setServerUrl(s.url);
    setPairError(null);
    void runProbe(s.url);
    setTimeout(() => codeRef.current?.focus(), 50);
  };

  const normalizedCode = normalizeCodeInput(code);
  const canPair = serverUrl.trim().length > 0 && normalizedCode.length >= 4 && deviceName.trim().length > 0 && !pairing;
  const onPair = () => void pairWith({ url: serverUrl, code, name: deviceName });

  const needsInstall = isWeb && !isStandaloneWeb() && isIosSafariWeb();

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={[{ flex: 1 }, webInset > 0 ? { paddingBottom: webInset } : null]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 24, gap: 22, paddingBottom: 40, maxWidth: 520, width: '100%', alignSelf: 'center' }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={KEYBOARD_DISMISS_ON_DRAG}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <BrandMark size={34} />
            <T weight="600" style={{ flex: 1, letterSpacing: -0.5 }}>
              mobile ide
            </T>
            <T variant="label" color="textFaint">
              Connect
            </T>
          </View>
          {alreadyPaired ? (
            <Notice
              tone="info"
              icon="link-outline"
              text={`Connected to ${savedServerName ?? 'your computer'}. Connecting again replaces this device’s saved connection.`}
              actionLabel="Back"
              onAction={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            />
          ) : null}
          <View style={{ gap: 10, paddingTop: 12 }}>
            <T variant="display" accessibilityRole="header" style={{ fontSize: 36, lineHeight: 42, letterSpacing: -1.4 }}>
              Your workspace.{'\n'}Within reach.
            </T>
            <T color="textMuted" style={{ maxWidth: 390 }}>
              Start a task, check the progress, keep building. Connect to the computer where your code lives.
            </T>
          </View>
          {needsInstall ? (
            <Notice
              tone="warning"
              icon="download-outline"
              text="On iPhone, add this app to your Home Screen before connecting for full-screen access and notifications."
              actionLabel={showInstallHelp ? 'Hide' : 'How'}
              onAction={() => setShowInstallHelp((v) => !v)}
            />
          ) : null}
          {showInstallHelp ? (
            <Card>
              <Step n={1} text="Tap Share in Safari." />
              <Step n={2} text="Choose Add to Home Screen, then Add." />
              <Step n={3} text="Open Mobile IDE from your Home Screen and enter your code." last />
            </Card>
          ) : null}
          <Card style={{ padding: 20, gap: 18 }}>
            <TextField
              label="Server address"
              mono
              value={serverUrl}
              onChangeText={(v) => {
                setServerUrl(v);
                setProbe({ state: 'idle' });
                probeSeq.current++;
                if (pairError) setPairError(null);
              }}
              onBlur={onServerBlur}
              placeholder="https://your-computer.example.com"
              keyboardType="url"
              textContentType="URL"
              autoComplete="off"
              returnKeyType="next"
              onSubmitEditing={() => {
                onServerBlur();
                codeRef.current?.focus();
              }}
              right={<ProbeIndicator probe={probe} />}
            />
            <ProbeStatus probe={probe} />
            <RecentServers current={serverUrl} onPick={onPickServer} />
            <TextField
              ref={codeRef}
              label="Pairing code"
              mono
              value={code}
              onChangeText={onCodeChange}
              placeholder="ABCD-1234"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={120}
              returnKeyType="go"
              textContentType="oneTimeCode"
              hint={CODE_HINT}
              onSubmitEditing={() => {
                if (canPair) onPair();
              }}
              style={{ fontSize: 20, letterSpacing: 3 }}
            />
            {pairError ? <Notice tone="danger" icon="alert-circle" text={pairError} /> : null}
            <Button
              title="Connect to workspace"
              icon="arrow-forward"
              size="lg"
              onPress={onPair}
              loading={pairing}
              disabled={!canPair}
              full
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                title="Paste link or code"
                variant="secondary"
                icon="clipboard-outline"
                onPress={() => void onPaste()}
                loading={pasting}
                disabled={pairing}
                full
                style={{ flex: 1 }}
                size="sm"
              />
              {qrScanSupported ? (
                <Button
                  title="Scan QR"
                  variant="secondary"
                  icon="qr-code-outline"
                  onPress={() => setScanning(true)}
                  disabled={pairing}
                  size="sm"
                />
              ) : null}
            </View>
            <Tap
              onPress={() => setShowDeviceOptions((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel="Device options"
              accessibilityState={{ expanded: showDeviceOptions }}
              style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <Ionicons name="phone-portrait-outline" size={16} color={t.colors.textFaint} />
              <T variant="caption" color="textMuted" style={{ flex: 1 }} numberOfLines={1}>
                Connecting as {deviceName || 'this device'}
              </T>
              <Ionicons name={showDeviceOptions ? 'chevron-up' : 'chevron-down'} size={15} color={t.colors.textFaint} />
            </Tap>
            {showDeviceOptions ? (
              <View style={{ gap: 12 }}>
                <TextField
                  label="Device name"
                  value={deviceName}
                  onChangeText={(v) => {
                    setDeviceName(v);
                    if (pairError) setPairError(null);
                  }}
                  placeholder="iPhone"
                  maxLength={80}
                  autoCapitalize="words"
                  returnKeyType="go"
                  hint="A name to recognize this device on your computer."
                  onSubmitEditing={() => {
                    if (canPair) onPair();
                  }}
                />
                <Button
                  title="Test connection"
                  variant="secondary"
                  icon="pulse-outline"
                  onPress={() => void runProbe(serverUrl)}
                  loading={probe.state === 'checking'}
                  disabled={!serverUrl.trim()}
                  full
                />
              </View>
            ) : null}
          </Card>
          <View style={{ gap: 10 }}>
            <Tap
              onPress={() => setShowSetupHelp((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel="Get a pairing code"
              accessibilityState={{ expanded: showSetupHelp }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}
            >
              <Ionicons name="terminal-outline" size={19} color={t.colors.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="bodySmall" weight="600">
                  First time here?
                </T>
                <T variant="caption" color="textMuted">
                  Get a pairing code from your computer.
                </T>
              </View>
              <Ionicons name={showSetupHelp ? 'chevron-up' : 'chevron-down'} size={16} color={t.colors.textMuted} />
            </Tap>
            {showSetupHelp ? (
              <Card style={{ gap: 14 }}>
                <T variant="bodySmall" color="textMuted">
                  With Mobile IDE running on your computer, open a terminal and run:
                </T>
                <CodeBlock code="mide pair" />
                <T variant="bodySmall" color="textMuted">
                  Open the printed link or enter its server address and code above. Each code works once and expires after 10 minutes.
                </T>
              </Card>
            ) : null}
          </View>
          <T variant="caption" color="textFaint" align="center">
            Your code and agent sessions stay on your computer.
          </T>
        </ScrollView>
      </KeyboardAvoidingView>
      <QrScanSheet visible={scanning} onClose={() => setScanning(false)} onScanned={(parsed) => applyLink(parsed, { autoPair: true })} />
    </Screen>
  );
}

function platformLabel(): string {
  if (Platform.OS === 'web') return isStandaloneWeb() ? 'web-standalone' : 'web';
  return Platform.OS;
}

/** `ABCD-1234`, `abcd 1234`, `ABCD1234`: 6–16 alphanumerics once dashes/spaces are dropped. */
function looksLikeBareCode(text: string): boolean {
  const s = normalizeCodeInput(text);
  return /^[A-Z0-9]{6,16}$/.test(s);
}

/** The probe hits GET /api/health unauthenticated; anything that is not our JSON means "not a daemon". */
function friendlyProbeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_response' || err.code === 'not_found') {
      return 'No mobile-ide daemon answered at this address (unexpected reply from /api/health). Check the URL and port — the daemon listens on 4820 by default.';
    }
    return err.message;
  }
  return errorMessage(err);
}

function friendlyPairError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'not_found')
      return 'No mobile-ide daemon answered at this URL (/api/pair not found). Check the address and that `mide serve` is running.';
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      return 'That code was rejected. Codes are single-use and expire after 10 minutes — run `mide pair` again and enter the new code.';
    }
    if (err.status === 429) return 'Too many attempts from this address. Wait a minute, then try again.';
    return err.message;
  }
  return errorMessage(err);
}

/** Daemons this device has paired with before — one tap re-fills the URL. Long-press removes an entry. */
function RecentServers({ current, onPick }: { current: string; onPick: (s: KnownServer) => void }) {
  const servers = useServerHistory((s) => s.servers);
  if (servers.length === 0) return null;
  const cur = normalizeServerUrl(current);
  return (
    <View style={{ gap: 6, marginTop: -4 }} accessibilityLabel="Recent servers">
      <T variant="caption" color="textFaint">
        Recent servers · tap to use, hold to remove
      </T>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
        keyboardShouldPersistTaps="handled"
      >
        {servers.map((s) => {
          const label = knownServerLabel(s);
          return (
            <Tap
              key={s.url}
              onPress={() => onPick(s)}
              onLongPress={() => {
                forgetKnownServer(s.url);
                void haptic.light();
                toast.info(`Removed ${label} from recent servers`);
              }}
              pressedColor={null}
              accessibilityRole="button"
              accessibilityLabel={`Use ${label}${s.name ? ` at ${s.url}` : ''}`}
              accessibilityHint="Long press to remove"
              testID={`recent-server-${label}`}
            >
              <Chip label={label} icon="time-outline" size="md" selected={s.url === cur} maxWidth={240} />
            </Tap>
          );
        })}
      </ScrollView>
    </View>
  );
}

function ProbeIndicator({ probe }: { probe: Probe }) {
  const t = useTheme();
  if (probe.state === 'checking') return <ActivityIndicator size="small" color={t.colors.accent} />;
  if (probe.state === 'ok') return <Ionicons name="checkmark-circle" size={20} color={t.colors.success} />;
  if (probe.state === 'fail') return <Ionicons name="alert-circle" size={20} color={t.colors.danger} />;
  return null;
}

function ProbeStatus({ probe }: { probe: Probe }) {
  const t = useTheme();
  if (probe.state === 'idle' || probe.state === 'checking') return null;
  const ok = probe.state === 'ok';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: -4 }}>
      <Ionicons
        name={ok ? 'checkmark-circle-outline' : 'cloud-offline-outline'}
        size={16}
        color={ok ? t.colors.success : t.colors.danger}
        style={{ marginTop: 1 }}
      />
      <T variant="bodySmall" style={{ color: ok ? t.colors.success : t.colors.danger, flex: 1 }}>
        {ok ? `${probe.serverName} is ready to connect` : probe.message}
      </T>
    </View>
  );
}

function Step({ n, text, last }: { n: number; text: string; last?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: last ? 0 : 12 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: t.colors.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        <T style={{ color: t.colors.accent, fontSize: 12, fontWeight: '700' }}>{n}</T>
      </View>
      <T variant="bodySmall" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

/** Multi-line notice (the kit's Banner clamps to two lines, which would truncate error text). */
function Notice({
  tone,
  icon,
  text,
  actionLabel,
  onAction,
}: {
  tone: 'info' | 'warning' | 'danger';
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  const fg = { info: t.colors.info, warning: t.colors.warning, danger: t.colors.danger }[tone];
  const bg = { info: t.colors.infoSoft, warning: t.colors.warningSoft, danger: t.colors.dangerSoft }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: t.radius.md, padding: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <Ionicons name={icon} size={18} color={fg} style={{ marginTop: 1 }} />
      <T variant="bodySmall" style={{ color: fg, flex: 1 }}>
        {text}
      </T>
      {actionLabel && onAction ? (
        <Button
          title={actionLabel}
          size="sm"
          variant="ghost"
          onPress={onAction}
          style={{ minHeight: 44, paddingHorizontal: 6, marginRight: -6 }}
        />
      ) : null}
    </View>
  );
}
