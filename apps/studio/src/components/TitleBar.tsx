import { basename } from '../lib/paths';
import { openNewSession, openPalette, setAutoSwitch, toggleTheme, togglePanel } from '../state/controller';
import { useStudio } from '../state/store';
import { Icon } from './Icons';

export function TitleBar() {
  const conn = useStudio((s) => s.conn);
  const serverName = useStudio((s) => s.serverName);
  const root = useStudio((s) => s.root);
  const branch = useStudio((s) => s.gitBranch);
  const autoSwitch = useStudio((s) => s.autoSwitch);
  const theme = useStudio((s) => s.theme);
  const explorerOpen = useStudio((s) => s.explorerOpen);
  const railOpen = useStudio((s) => s.railOpen);
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="terminal" size={21} />
        </span>
        <div className="brand-copy">
          <strong>
            Mobile IDE <span>Studio</span>
          </strong>
          <span className="machine-label">
            <span className={`dot conn-${conn}`} />
            {serverName || 'Your workspace'}
          </span>
        </div>
      </div>
      <button type="button" className="palette-btn" onClick={() => openPalette(true)} aria-label="Search files, sessions and commands">
        <Icon name="search" size={15} />
        <span>{root ? basename(root) : 'Find in your workspace'}</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="title-actions">
        {branch ? (
          <span className="branch-label" title={branch}>
            <Icon name="git-branch" size={13} />
            {branch}
          </span>
        ) : null}
        <button
          type="button"
          className={`icon-btn panel-control ${autoSwitch ? 'active' : ''}`}
          onClick={() => setAutoSwitch(!autoSwitch)}
          title="Switch to new sessions automatically"
          aria-label="Switch to new sessions automatically"
          aria-pressed={autoSwitch}
        >
          <Icon name="zap" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn panel-control ${explorerOpen ? 'active' : ''}`}
          onClick={() => togglePanel('explorer')}
          aria-label="Toggle files panel"
          aria-pressed={explorerOpen}
          title="Files · ⌘B"
        >
          <Icon name="panel-left" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn panel-control ${railOpen ? 'active' : ''}`}
          onClick={() => togglePanel('rail')}
          aria-label="Toggle agent panel"
          aria-pressed={railOpen}
          title="Agent · ⌘J"
        >
          <Icon name="panel-right" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button type="button" className="btn btn-primary new-session-trigger" onClick={() => openNewSession(true)}>
          <Icon name="plus" size={15} />
          <span>New session</span>
        </button>
      </div>
    </header>
  );
}
