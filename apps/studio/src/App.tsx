import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { EditorPane } from './components/EditorPane';
import { Explorer } from './components/Explorer';
import { Icon } from './components/Icons';
import { NewSession } from './components/NewSession';
import { SessionRail } from './components/SessionRail';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import { boot, closeTab, openPalette, repair, saveDoc, setPanelWidth, setWorkspaceView, togglePanel } from './state/controller';
import { savePrefs, useStudio } from './state/store';

export function App() {
  const auth = useStudio((s) => s.auth);
  const authError = useStudio((s) => s.authError);
  const explorerOpen = useStudio((s) => s.explorerOpen);
  const railOpen = useStudio((s) => s.railOpen);
  const explorerWidth = useStudio((s) => s.explorerWidth);
  const railWidth = useStudio((s) => s.railWidth);
  const conn = useStudio((s) => s.conn);
  const pendingCount = useStudio((s) => s.sessions.find((session) => session.id === s.followSessionId)?.pendingPermissions ?? 0);
  const [compact, setCompact] = useState(window.innerWidth < 980);
  const view = useStudio((s) => s.workspaceView);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 979px)');
    const update = () => setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === 'Escape' && useStudio.getState().paletteOpen) openPalette(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (useStudio.getState().newSessionOpen) return;
      if (useStudio.getState().paletteOpen && k !== 'k' && k !== 'p') return;
      if (k === 'k' || (k === 'p' && !e.shiftKey)) {
        e.preventDefault();
        openPalette(!useStudio.getState().paletteOpen);
      } else if (k === 'b') {
        e.preventDefault();
        togglePanel('explorer');
      } else if (k === 'j') {
        e.preventDefault();
        togglePanel('rail');
      } else if (k === 's') {
        e.preventDefault();
        const key = useStudio.getState().activeKey;
        if (key) void saveDoc(key);
      } else if (k === 'w') {
        const key = useStudio.getState().activeKey;
        if (key) {
          e.preventDefault();
          closeTab(key);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.values(useStudio.getState().docs).some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (auth !== 'ready') return <Gate phase={auth} error={authError} />;

  const columns = [
    explorerOpen ? `min(${explorerWidth}px, 25vw) 6px` : '',
    'minmax(320px, 1fr)',
    railOpen ? `6px min(${railWidth}px, 38vw)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="app">
      <TitleBar />
      {conn !== 'open' ? (
        <div className="connection-banner" role="status">
          <Icon name="radio" size={14} /> Reconnecting to your machine. Your edits and drafts are safe here.
        </div>
      ) : null}
      {compact ? (
        <nav className="workspace-nav" aria-label="Workspace view">
          {(['files', 'editor', 'session'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? 'active' : ''}
              aria-pressed={view === item}
              onClick={() => setWorkspaceView(item)}
            >
              <Icon name={item === 'files' ? 'folder' : item === 'editor' ? 'file' : 'sparkles'} size={15} />
              {item === 'session' ? 'Agent' : item === 'files' ? 'Files' : 'Editor'}
              {item === 'session' && pendingCount > 0 ? (
                <span className="count attention-count" aria-label={`${pendingCount} requests need attention`}>
                  {pendingCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      ) : null}
      <main className="workspace" style={{ gridTemplateColumns: compact ? 'minmax(0, 1fr)' : columns }}>
        {explorerOpen || compact ? (
          <>
            <div className="workspace-pane" hidden={compact && view !== 'files'}>
              <Explorer />
            </div>
            {!compact ? <Resizer which="explorer" /> : null}
          </>
        ) : null}
        <div className="workspace-pane" hidden={compact && view !== 'editor'}>
          <EditorPane />
        </div>
        {railOpen || compact ? (
          <>
            {!compact ? <Resizer which="rail" /> : null}
            <div className="workspace-pane" hidden={compact && view !== 'session'}>
              <SessionRail />
            </div>
          </>
        ) : null}
      </main>
      <CommandPalette />
      <NewSession />
      <Toasts />
    </div>
  );
}

function Resizer({ which }: { which: 'explorer' | 'rail' }) {
  const width = useStudio((s) => (which === 'explorer' ? s.explorerWidth : s.railWidth));
  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = useStudio.getState();
    dragging.current = { startX: e.clientX, startW: which === 'explorer' ? s.explorerWidth : s.railWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragging.current;
    if (!d) return;
    const delta = e.clientX - d.startX;
    setPanelWidth(which, which === 'explorer' ? d.startW + delta : d.startW - delta);
  };
  const onUp = () => {
    dragging.current = null;
    document.body.classList.remove('resizing');
    savePrefs();
  };
  return (
    <div
      className="resizer"
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${which === 'explorer' ? 'files' : 'agent'} panel`}
      aria-valuenow={width}
      aria-valuemin={which === 'explorer' ? 180 : 300}
      aria-valuemax={which === 'explorer' ? 480 : 640}
      aria-orientation="vertical"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const s = useStudio.getState();
        const delta = e.key === 'ArrowRight' ? 20 : -20;
        setPanelWidth(which, which === 'explorer' ? s.explorerWidth + delta : s.railWidth - delta);
        savePrefs();
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => togglePanel(which)}
    />
  );
}

function Gate({ phase, error }: { phase: 'booting' | 'pairing' | 'unpaired' | 'error'; error: string | null }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="hero-mark">
          <span className={`hero-dot ${phase === 'booting' || phase === 'pairing' ? 'pulsing' : ''}`} />
        </div>
        <div className="wordmark big">
          Mobile IDE <span className="wordmark-studio">Studio</span>
        </div>
        {phase === 'booting' ? <p className="muted">Opening your workspace…</p> : null}
        {phase === 'pairing' ? <p className="muted">Connecting this window to your machine…</p> : null}
        {phase === 'unpaired' ? (
          <>
            <p>This window is not paired with the daemon{error ? `: ${error}` : '.'}</p>
            <p className="muted">
              Open the Studio from the machine that runs the daemon — <code>mide studio</code> — or start a session from your phone; the
              daemon opens a paired window for you.
            </p>
          </>
        ) : null}
        {phase === 'error' ? (
          <>
            <p>
              <Icon name="alert" size={14} /> {error ?? 'Something went wrong.'}
            </p>
            <div className="perm-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => location.reload()}>
                Retry
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={repair}>
                Forget pairing
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
