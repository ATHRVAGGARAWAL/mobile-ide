/**
 * Bottom sheet for answering an elicitation: the agent's question as a form (chips / option rows / text / numbers /
 * toggles) or a URL hand-off (host and full URL shown before anything opens). Required fields are validated with
 * core's validator before sending — the same one the daemon applies. "Send answer" / "Skip" / "Dismiss" are ACP
 * accept / decline / cancel. Optimistic via the sessions store (which also queues the answer while offline).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import {
  elicitationDefaults,
  validateElicitationContent,
  type ElicitationAction,
  type ElicitationContent,
  type ElicitationRequest,
  type ElicitationSchema,
  type ElicitationValue,
} from '@mobile-ide/core';
import { relativeTime } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { useNow } from '../../lib/useNow';
import { useConnection } from '../../state/connection';
import { useSessions } from '../../state/sessions';
import { toast } from '../../state/toast';
import { useTheme } from '../../theme/ThemeProvider';
import { AgentBadge } from '../ui/AgentBadge';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { CodeBlock } from '../ui/CodeBlock';
import { Sheet } from '../ui/Sheet';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { ElicitationForm } from './ElicitationForm';
import { compactAnswers, describeElicitation, elicitationIcon, isHttps, resolutionInfo, urlHost } from './elicitationUtils';

export interface ElicitationSheetProps {
  /** null hides the sheet (the last request stays mounted for the exit animation) */
  request: ElicitationRequest | null;
  onClose: () => void;
}

const EMPTY_SCHEMA: ElicitationSchema = { properties: {}, required: [] };

export function ElicitationSheet({ request, onClose }: ElicitationSheetProps) {
  const t = useTheme();
  const c = t.colors;
  const now = useNow();

  // Show the live request immediately; keep the last one mounted while the sheet animates out.
  const [lastShown, setLastShown] = useState<ElicitationRequest | null>(request);
  useEffect(() => {
    if (request) setLastShown(request);
  }, [request]);
  const shown = request ?? lastShown;
  const elicitationId = shown?.elicitationId;
  const schema = shown?.mode === 'form' ? (shown.schema ?? EMPTY_SCHEMA) : null;

  const [answers, setAnswers] = useState<ElicitationContent>(() => (schema ? elicitationDefaults(schema) : {}));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<ElicitationAction | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<ElicitationAction | null>(null);
  const [answeredHere, setAnsweredHere] = useState(false);
  useEffect(() => {
    setAnswers(schema ? elicitationDefaults(schema) : {});
    setShowErrors(false);
    setBusy(null);
    setConfirmDismiss(false);
    setError(null);
    setLastAttempt(null);
    setAnsweredHere(false);
    // `schema` is derived from the request; a new elicitationId is what resets the form
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elicitationId]);

  const session = useSessions((s) => (shown ? s.sessions.find((x) => x.id === shown.sessionId) : undefined));
  const resolved = useSessions((s) => {
    if (!shown) return undefined;
    const tl = s.timelines[shown.sessionId];
    if (!tl) return undefined;
    const idx = tl.elicitationIndex[shown.elicitationId];
    if (idx === undefined) return undefined;
    const item = tl.items[idx];
    return item && item.kind === 'elicitation' ? item.resolved : undefined;
  });
  const submit = useSessions((s) => (shown ? s.elicitationSubmit[shown.elicitationId] : undefined));
  const connState = useConnection((s) => s.state);

  const problems = useMemo(() => (schema ? validateElicitationContent(schema, answers) : {}), [schema, answers]);
  const visibleErrors = showErrors ? problems : {};
  const fieldCount = schema ? Object.keys(schema.properties).length : 0;

  const onFieldChange = useCallback((name: string, value: ElicitationValue | undefined) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  }, []);

  const send = useCallback(
    async (action: ElicitationAction) => {
      if (!shown || busy) return;
      let content: ElicitationContent | undefined;
      if (action === 'accept' && shown.mode === 'form') {
        if (Object.keys(problems).length) {
          setShowErrors(true);
          void haptic.error();
          return;
        }
        content = compactAnswers(answers);
      }
      setError(null);
      setBusy(action);
      setAnsweredHere(true);
      const result = await useSessions.getState().respondElicitation(shown.sessionId, shown.elicitationId, action, content);
      setBusy(null);
      if (result === 'error') {
        setAnsweredHere(false);
        setLastAttempt(action);
        setError("Your answer didn't reach the daemon. Check the connection and try again.");
        void haptic.error();
        return;
      }
      if (result === 'queued') toast.info('Offline — your answer is queued and will be sent when the connection returns.');
      void (action === 'accept' ? haptic.success() : haptic.warning());
      onClose();
    },
    [shown, busy, problems, answers, onClose],
  );

  /** Consent = accept: the agent is told right away (it may complete the flow itself); the link opens meanwhile. */
  const openLink = useCallback(() => {
    if (!shown?.url || busy) return;
    const url = shown.url;
    void WebBrowser.openBrowserAsync(url).catch(() =>
      Linking.openURL(url).catch(() => {
        toast.error("Couldn't open the link — copy it from the sheet instead.");
      }),
    );
    void send('accept');
  }, [shown, busy, send]);

  const retry = useCallback(() => {
    if (lastAttempt) void send(lastAttempt);
  }, [lastAttempt, send]);

  if (!shown) return null;

  const answeredElsewhere = !!resolved && !answeredHere;
  const resolution = resolved ? resolutionInfo(shown, resolved) : null;
  const isUrl = shown.mode === 'url';
  const host = isUrl && shown.url ? urlHost(shown.url) : null;
  const secure = isUrl && !!shown.url && isHttps(shown.url);

  let footer: React.ReactNode;
  if (answeredElsewhere && resolution) {
    footer = <Button title="Done" variant="secondary" size="lg" full onPress={onClose} />;
  } else if (confirmDismiss) {
    footer = (
      <View style={styles.footer}>
        {error ? <Banner tone="danger" message={error} compact /> : null}
        <Card tone="danger">
          <T variant="subheading">Dismiss without answering?</T>
          <T variant="bodySmall" color="textMuted" style={{ marginTop: 4 }}>
            This cancels the request. Choose Skip to decline while letting the agent continue.
          </T>
        </Card>
        <View style={styles.row}>
          <Button
            title="Back"
            variant="secondary"
            size="lg"
            style={styles.grow}
            disabled={busy !== null}
            onPress={() => setConfirmDismiss(false)}
          />
          <Button
            title="Dismiss"
            icon="close-circle-outline"
            variant="danger"
            size="lg"
            style={styles.grow}
            loading={busy === 'cancel'}
            onPress={() => void send('cancel')}
          />
        </View>
      </View>
    );
  } else {
    footer = (
      <View style={styles.footer}>
        {error ? (
          <Banner
            tone="danger"
            message={error}
            actionLabel={lastAttempt ? 'Retry' : undefined}
            onAction={lastAttempt ? retry : undefined}
            compact
          />
        ) : null}
        {isUrl ? (
          <Button
            title="Open link"
            accessibilityLabel={host ? `Open ${host}` : 'Open link'}
            icon="open-outline"
            variant="primary"
            size="lg"
            full
            loading={busy === 'accept'}
            disabled={busy !== null || !shown.url}
            onPress={openLink}
          />
        ) : (
          <Button
            title={fieldCount === 0 ? 'Confirm' : 'Send answer'}
            icon="send-outline"
            variant="primary"
            size="lg"
            full
            loading={busy === 'accept'}
            disabled={busy !== null}
            onPress={() => void send('accept')}
          />
        )}
        <Button
          title="Skip"
          icon="play-skip-forward-outline"
          variant="secondary"
          size="lg"
          full
          loading={busy === 'decline'}
          disabled={busy !== null}
          accessibilityLabel="Skip: tell the agent you would rather not answer"
          onPress={() => void send('decline')}
        />
        <Tap
          onPress={() => setConfirmDismiss(true)}
          disabled={busy !== null}
          pressedColor={null}
          style={styles.cancelLink}
          accessibilityRole="button"
          accessibilityLabel="Dismiss without answering"
        >
          <T variant="bodySmall" color="textMuted">
            Dismiss request
          </T>
        </Tap>
      </View>
    );
  }

  return (
    <Sheet
      visible={request !== null}
      onClose={onClose}
      title={
        answeredElsewhere ? (isUrl ? 'Link reviewed' : 'Question answered') : isUrl ? 'Continue in your browser' : 'A question for you'
      }
      subtitle={session ? `${session.agentName} · ${session.title}` : describeElicitation(shown)}
      footer={footer}
      maxHeightRatio={0.92}
    >
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <View style={[styles.kindBox, { backgroundColor: answeredElsewhere ? c.surfaceAlt : c.warningSoft }]}>
            <Ionicons name={elicitationIcon(shown)} size={20} color={answeredElsewhere ? c.textMuted : c.warning} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="subheading" selectable>
              {shown.message}
            </T>
            <View style={styles.metaRow}>
              {session ? <AgentBadge agent={session.agent} name={session.agentName} /> : null}
              <T variant="caption">
                {describeElicitation(shown)} · asked {relativeTime(shown.createdAt, now)}
              </T>
            </View>
          </View>
        </View>

        {answeredElsewhere && resolution ? (
          <Banner
            tone={resolution.tone === 'success' ? 'success' : resolution.tone === 'danger' ? 'danger' : 'neutral'}
            icon={resolution.icon}
            message={`Already answered: ${resolution.label}${submit === 'queued' ? ' (queued until reconnected)' : ''}`}
          />
        ) : connState !== 'open' ? (
          <Banner tone="warning" message="Offline — your answer will be queued and sent when the connection returns." compact />
        ) : null}

        {isUrl ? (
          <View style={styles.section}>
            <T variant="label">Where you'll be sent</T>
            <View style={styles.chips}>
              <Chip
                label={host ?? 'unknown host'}
                icon={secure ? 'lock-closed-outline' : 'lock-open-outline'}
                size="md"
                mono
                maxWidth={320}
              />
            </View>
            {shown.url ? <CodeBlock code={shown.url} wrap /> : <Banner tone="danger" message="The agent sent no URL." compact />}
            {!secure && shown.url ? (
              <Banner tone="warning" message="This link is not HTTPS. Only continue if you trust where it leads." compact />
            ) : null}
            <T variant="caption" color="textFaint">
              Opening this link tells the agent you accepted the request and continues in your browser.
            </T>
          </View>
        ) : schema && !answeredElsewhere ? (
          fieldCount === 0 ? (
            <Banner
              tone="neutral"
              icon="information-circle-outline"
              message="Nothing to fill in — the agent only needs your confirmation."
              compact
            />
          ) : (
            <ElicitationForm
              key={shown.elicitationId}
              schema={schema}
              value={answers}
              errors={visibleErrors}
              onChange={onFieldChange}
              disabled={busy !== null}
            />
          )
        ) : null}

        {shown.toolCallId && !isUrl ? (
          <T variant="caption" color="textFaint">
            Skip tells the agent you'd rather not answer; it continues without your input.
          </T>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 20, paddingBottom: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  kindBox: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  section: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  footer: { gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  cancelLink: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
});
