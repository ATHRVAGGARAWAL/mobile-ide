import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { AgentInfo, ContentBlock, SessionMode } from '@mobile-ide/core';
import { useWebKeyboardInset } from '../src/components/chat/useKeyboardInset';
import {
  AgentPicker,
  ChipSelect,
  ProjectField,
  ProjectPickerSheet,
  SESSION_WORKFLOWS,
  agentAvailability,
  agentSelectable,
} from '../src/components/sessions';
import { Banner, Button, IconButton, Screen, T, Tap, TextField } from '../src/components/ui';
import { haptic } from '../src/lib/haptics';
import { useAsync } from '../src/lib/useAsync';
import { api, errorMessage } from '../src/state/api';
import { useProjects } from '../src/state/projects';
import { useSessions } from '../src/state/sessions';
import { useTheme } from '../src/theme/ThemeProvider';
import { KEYBOARD_DISMISS_ON_DRAG } from '../src/lib/platform';

/** Optional prefill via `/new-session?agent=&cwd=&prompt=` (e.g. "new session in this project" from a chat menu). */
type Params = { agent: string; cwd: string; prompt: string };
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

const MAX_TITLE = 200;
/** Model chips shown before "+N more" (OpenCode advertises dozens; the form must stay one screen tall). */
const MODEL_CHIPS_VISIBLE = 6;

export default function NewSessionScreen() {
  const router = useRouter();
  const t = useTheme();
  const params = useLocalSearchParams<Params>();
  // iOS Safari (incl. the installed PWA) shrinks only the visual viewport: pad by the covered band so the pinned footer rides above the keyboard.
  const webInset = useWebKeyboardInset();
  const agentsQ = useAsync(() => api.agents(), []);
  const sessions = useSessions((s) => s.sessions);
  const projects = useProjects((s) => s.projects);
  const selectedRoot = useProjects((s) => s.selectedRoot);
  const loadProjects = useProjects((s) => s.load);

  const [agent, setAgent] = useState<string | null>(one(params.agent) ?? null);
  const [cwd, setCwd] = useState<string | null>(one(params.cwd) ?? null);
  const [title, setTitle] = useState('');
  const [modeId, setModeId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(one(params.prompt) ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Agents from REST; if that fails, fall back to the agents seen on existing sessions so the form still works.
  const agents = useMemo<AgentInfo[] | undefined>(() => {
    if (agentsQ.data) return agentsQ.data;
    if (!agentsQ.error) return undefined;
    const seen = new Map<string, AgentInfo>();
    for (const s of sessions) if (!seen.has(s.agent)) seen.set(s.agent, { id: s.agent, name: s.agentName, available: true });
    return seen.size ? [...seen.values()] : undefined;
  }, [agentsQ.data, agentsQ.error, sessions]);

  // Default agent: the one you used most recently if it can start, else the first that can.
  useEffect(() => {
    if (agent || !agents?.length) return;
    const recent = sessions[0]?.agent;
    const pick = agents.find((a) => a.id === recent && agentSelectable(a)) ?? agents.find(agentSelectable) ?? agents[0];
    if (pick) setAgent(pick.id);
  }, [agent, agents, sessions]);

  // Default project: the one selected in Files/Changes/Terminal, else the most recently used.
  useEffect(() => {
    if (cwd) return;
    const fallback = selectedRoot ?? projects[0]?.root ?? null;
    if (fallback) setCwd(fallback);
  }, [cwd, selectedRoot, projects]);

  // Mode/model choices are per agent; reset them when the agent changes.
  useEffect(() => {
    setModeId(null);
    setModel(null);
  }, [agent]);

  const agentInfo = agents?.find((a) => a.id === agent);
  const avail = agentInfo ? agentAvailability(agentInfo) : null;

  // Modes are only advertised once an agent process exists; the most recent session of this agent knows them.
  const knownModes = useMemo<SessionMode[]>(() => {
    if (!agent) return [];
    for (const s of sessions) if (s.agent === agent && s.availableModes?.length) return s.availableModes;
    return [];
  }, [agent, sessions]);
  const models = agentInfo?.models ?? [];

  const promptText = prompt.trim();
  const canSubmit = !!agent && !!cwd && !submitting;

  const goToSession = useCallback(
    (id: string) => {
      const href = { pathname: '/session/[id]', params: { id } } as const;
      if (router.canDismiss()) {
        router.dismiss();
        router.push(href);
      } else {
        router.replace(href);
      }
    },
    [router],
  );

  const cancel = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const submit = useCallback(async () => {
    if (!agent || !cwd || submitting) return;
    setSubmitting(true);
    setError(null);
    const initialPrompt: ContentBlock[] | undefined = promptText ? [{ type: 'text', text: promptText }] : undefined;
    try {
      const summary = await api.createSession({
        agent,
        cwd,
        title: title.trim() || undefined,
        modeId: modeId ?? undefined,
        model: model ?? undefined,
        initialPrompt,
      });
      useSessions.getState().upsertSession(summary);
      useProjects.getState().select(summary.cwd);
      void haptic.success();
      goToSession(summary.id);
    } catch (err) {
      setError(errorMessage(err));
      void haptic.error();
    } finally {
      setSubmitting(false);
    }
  }, [agent, cwd, submitting, promptText, title, modeId, model, goToSession]);

  const footerNote = submitting
    ? `Starting ${agentInfo?.name ?? 'the agent'}… a cold start can take about 10 seconds.`
    : avail?.kind === 'on_demand' && agentInfo
      ? `${agentInfo.name} will be launched on your laptop first.`
      : 'Runs on your laptop and keeps going when you close the app.';

  return (
    <Screen edges={['top', 'bottom']}>
      <Stack.Screen options={{ title: 'New session', presentation: 'modal', headerShown: false }} />
      <KeyboardAvoidingView
        style={[{ flex: 1 }, webInset > 0 ? { paddingBottom: webInset } : null]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          <View style={styles.header}>
            <View style={{ flex: 1, gap: 4 }}>
              <T variant="label" color="accent">
                A fresh start
              </T>
              <T variant="display" accessibilityRole="header">
                New session
              </T>
            </View>
            <IconButton name="close" label="Cancel new session" onPress={cancel} disabled={submitting} />
          </View>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: 20, gap: 24, paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={KEYBOARD_DISMISS_ON_DRAG}
          >
            <View style={{ gap: 12 }}>
              <T variant="heading">What do you want to work on?</T>
              <TextField
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Describe a task, ask a question, or explore an idea…"
                accessibilityLabel="First prompt"
                multiline
                autoCapitalize="sentences"
                autoCorrect
                editable={!submitting}
                style={{ minHeight: 138, textAlignVertical: 'top', paddingTop: 14, fontSize: 16, lineHeight: 23 }}
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {SESSION_WORKFLOWS.map((workflow) => (
                  <Tap
                    key={workflow.id}
                    onPress={() => setPrompt(workflow.prompt)}
                    disabled={submitting}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${workflow.title.toLowerCase()} workflow`}
                    accessibilityState={{ selected: prompt === workflow.prompt }}
                    style={{
                      minHeight: 44,
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 12,
                      gap: 6,
                      borderWidth: 1,
                      borderColor: prompt === workflow.prompt ? t.colors.accent : t.colors.border,
                      backgroundColor: t.colors.surface,
                      borderRadius: t.radius.md,
                    }}
                  >
                    <Ionicons name={workflow.icon} size={16} color={prompt === workflow.prompt ? t.colors.accent : t.colors.textMuted} />
                    <T variant="bodySmall" weight="500">
                      {workflow.title}
                    </T>
                  </Tap>
                ))}
              </View>
            </View>

            <Section title="Project" hint="Your agent will work inside this folder.">
              <ProjectField value={cwd} onPress={() => setPickerOpen(true)} disabled={submitting} />
            </Section>

            <Section title="Choose your agent">
              <AgentPicker
                agents={agents}
                loading={agentsQ.loading}
                error={agentsQ.error}
                onRetry={() => void agentsQ.reload()}
                value={agent}
                onChange={setAgent}
                disabled={submitting}
              />
              {agentsQ.error && agents ? (
                <T variant="caption" color="warning">
                  Availability could not be checked. Showing your recent agents.
                </T>
              ) : null}
              {avail?.kind === 'error' && agentInfo ? (
                <Banner
                  tone="warning"
                  message={`${agentInfo.name} could not start last time: ${avail.detail}. Starting will retry.`}
                  compact
                />
              ) : null}
            </Section>

            <View
              style={{
                borderWidth: 1,
                borderColor: t.colors.border,
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.lg,
                overflow: 'hidden',
              }}
            >
              <Tap
                onPress={() => setOptionsOpen((open) => !open)}
                accessibilityRole="button"
                aria-expanded={optionsOpen}
                style={{ minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}
              >
                <Ionicons name="options-outline" size={20} color={t.colors.textMuted} />
                <View style={{ flex: 1, gap: 3 }}>
                  <T variant="subheading">Session options</T>
                  <T variant="caption" color="textFaint" numberOfLines={2}>
                    {title.trim() || 'Automatic title'} · {model || 'Default model'}
                  </T>
                </View>
                <Ionicons name={optionsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={t.colors.textFaint} />
              </Tap>
              {optionsOpen ? (
                <View style={{ padding: 16, paddingTop: 4, gap: 20 }}>
                  <Section title="Title" optional>
                    <TextField
                      value={title}
                      onChangeText={setTitle}
                      placeholder="Named from your first prompt"
                      autoCapitalize="sentences"
                      autoCorrect
                      maxLength={MAX_TITLE}
                      editable={!submitting}
                    />
                  </Section>
                  {knownModes.length ? (
                    <Section title="Mode" hint="You can change this during the session.">
                      <ChipSelect
                        disabled={submitting}
                        options={knownModes.map((m) => ({ id: m.id, label: m.name, description: m.description }))}
                        value={modeId}
                        onChange={setModeId}
                        noneLabel="Agent default"
                      />
                    </Section>
                  ) : null}
                  {models.length ? (
                    <Section title="Model">
                      <ChipSelect
                        disabled={submitting}
                        options={models.map((m) => ({ id: m, label: m }))}
                        value={model}
                        onChange={setModel}
                        noneLabel={agentInfo?.defaultModel ? `Default (${agentInfo.defaultModel})` : 'Default'}
                        maxVisible={MODEL_CHIPS_VISIBLE}
                      />
                    </Section>
                  ) : null}
                </View>
              ) : null}
            </View>
            {error ? <Banner tone="danger" message={error} actionLabel="Retry" onAction={() => void submit()} /> : null}
          </ScrollView>
          <View style={[styles.footer, { borderTopColor: t.colors.border, backgroundColor: t.colors.bgElevated }]}>
            <Button
              title={promptText ? 'Start working' : 'Open session'}
              icon={promptText ? 'arrow-forward' : 'chatbubble-outline'}
              size="lg"
              full
              onPress={() => void submit()}
              disabled={!canSubmit}
              loading={submitting}
              accessibilityLabel={promptText ? 'Start session and send the first prompt' : 'Start session'}
            />
            <T variant="caption" color="textFaint" align="center" style={{ marginTop: 10 }}>
              {footerNote}
            </T>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ProjectPickerSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} value={cwd} onChange={setCwd} />
    </Screen>
  );
}

function Section({ title, optional, hint, children }: { title: string; optional?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <T variant="label">{title}</T>
        {optional ? (
          <T variant="caption" color="textFaint">
            optional
          </T>
        ) : null}
      </View>
      {children}
      {hint ? (
        <T variant="caption" color="textFaint">
          {hint}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 24 },
  footer: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
