import { useStudio } from '../state/store';
import { Icon } from './Icons';

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'radio'} size={14} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
