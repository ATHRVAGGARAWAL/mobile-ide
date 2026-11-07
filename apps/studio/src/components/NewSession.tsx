import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo } from '@mobile-ide/core';
import { api, errorMessage } from '../lib/api';
import { useDialog } from '../lib/useDialog';
import { createStudioSession, openNewSession } from '../state/controller';
import { useStudio } from '../state/store';
import { Icon, type IconName } from './Icons';

const WORKFLOWS: { id: string; name: string; icon: IconName; hint: string; prompt: string }[] = [
  { id: 'build', name: 'Build', icon: 'plus', hint: 'Bring an idea to life', prompt: '' },
  { id: 'fix', name: 'Fix', icon: 'pencil', hint: 'Find and solve a problem', prompt: 'Help me investigate and fix this issue:\n' },
  {
    id: 'review',
    name: 'Review',
    icon: 'eye',
    hint: 'Understand the changes',
    prompt: 'Review the current changes for bugs and explain what needs attention.',
  },
];

export function NewSession() {
  const open = useStudio((s) => s.newSessionOpen);
  const projects = useStudio((s) => s.projects);
  const conn = useStudio((s) => s.conn);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [task, setTask] = useState('');
  const [workflow, setWorkflow] = useState('build');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => {
    if (!busy) openNewSession(false);
  }, [busy]);
  useDialog(open, ref, close);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(null);
    setCwd((previous) => previous || useStudio.getState().root || useStudio.getState().projects[0]?.root || '');
    void api
      .agents()
      .then((items) => {
        if (!current) return;
        setAgents(items);
        setAgent((previous) =>
          items.some((item) => item.id === previous) ? previous : (items.find((item) => item.available)?.id ?? items[0]?.id ?? ''),
        );
      })
      .catch((err) => {
        if (current) setError(errorMessage(err));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, reload]);

  if (!open) return null;
  const selected = agents.find((item) => item.id === agent);
  const submit = async () => {
    if (busy || !agent || !cwd.trim() || conn !== 'open') return;
    setBusy(true);
    setError(null);
    try {
      await createStudioSession({
        agent,
        cwd: cwd.trim(),
        ...(model ? { model } : {}),
        ...(task.trim() ? { initialPrompt: [{ type: 'text', text: task.trim() }] } : {}),
      });
      setTask('');
      setWorkflow('build');
      setModel('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <span className="eyebrow">A fresh workspace</span>
            <h2 id="new-session-title">What are we working on?</h2>
          </div>
          <button className="icon-btn" type="button" aria-label="Close new session" disabled={busy} onClick={close}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className="workflow-options" disabled={busy}>
            <legend className="sr-only">Choose a starting point</legend>
            {WORKFLOWS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`workflow-option ${workflow === item.id ? 'selected' : ''}`}
                aria-pressed={workflow === item.id}
                onClick={() => {
                  setWorkflow(item.id);
                  if (!task.trim() || WORKFLOWS.some((w) => w.prompt.trim() === task.trim())) setTask(item.prompt);
                }}
              >
                <Icon name={item.icon} size={18} />
                <strong>{item.name}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </fieldset>
          <label className="form-field">
            <span>Project</span>
            <input
              className="input"
              list="studio-projects"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/your/project"
              required
              disabled={busy}
              autoComplete="off"
            />
            <datalist id="studio-projects">
              {projects.map((project) => (
                <option key={project.root} value={project.root}>
                  {project.name}
                </option>
              ))}
            </datalist>
          </label>
          <div className="form-row">
            <label className="form-field">
              <span>Agent</span>
              <select
                className="input"
                value={agent}
                onChange={(e) => {
                  setAgent(e.target.value);
                  setModel('');
                }}
                disabled={loading || busy}
                required
                aria-busy={loading}
              >
                {loading ? (
                  <option value="">Loading agents…</option>
                ) : !agents.length ? (
                  <option value="">No agents available</option>
                ) : null}
                {agents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.available ? '' : ' · unavailable'}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Model</span>
              <select
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy || !selected?.models?.length}
              >
                <option value="">Agent default</option>
                {selected?.models?.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selected && !selected.available ? (
            <p className="form-help">{selected.reason ?? 'This agent will try to reconnect when the session starts.'}</p>
          ) : null}
          <label className="form-field">
            <span>
              Your task <small>optional</small>
            </span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={busy}
              placeholder="Describe the outcome you want, add context, and let your agent get started…"
              rows={4}
            />
          </label>
          <p className="form-help">Leave the task empty to open a session and explore first.</p>
          {error ? (
            <div className="form-error" role="alert">
              {error}
              {!agents.length ? (
                <button type="button" onClick={() => setReload((n) => n + 1)}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {conn !== 'open' ? (
            <p className="form-error" role="status">
              Reconnecting. You can start this session once the connection returns.
            </p>
          ) : null}
          <div className="dialog-foot">
            <span>Your project stays on your machine.</span>
            <button type="submit" className="btn btn-primary" disabled={busy || loading || !agent || !cwd.trim() || conn !== 'open'}>
              {busy ? 'Starting session…' : task.trim() ? 'Start working' : 'Create session'}
              <Icon name="chevron-right" size={15} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
