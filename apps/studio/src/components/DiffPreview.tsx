import { useEffect, useState } from 'react';
import type { GitDiff } from '@mobile-ide/core';
import { api, errorMessage } from '../lib/api';
import { type Doc, useStudio } from '../state/store';
import { Icon } from './Icons';

export function DiffPreview({ doc }: { doc: Doc }) {
  const status = useStudio((s) => s.gitStatus[doc.path]);
  const [staged, setStaged] = useState(false);
  const [result, setResult] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void api
      .gitDiff(doc.root, doc.path, staged)
      .then((diff) => {
        if (current) setResult(diff);
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
  }, [doc.root, doc.path, doc.version, staged, status, retry]);
  return (
    <div className="diff-preview">
      <div className="diff-toolbar">
        <div className="segmented">
          <button type="button" aria-pressed={!staged} onClick={() => setStaged(false)}>
            Working tree
          </button>
          <button type="button" aria-pressed={staged} onClick={() => setStaged(true)}>
            Staged
          </button>
        </div>
        <button className="icon-btn" type="button" aria-label="Refresh changes" onClick={() => setRetry((n) => n + 1)}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {doc.dirty ? <p className="section-hint">Showing changes saved on disk. Save your edits to include them here.</p> : null}
      {loading ? (
        <div className="panel-empty" role="status">
          Loading changes…
        </div>
      ) : error ? (
        <div className="panel-empty" role="alert">
          <p>{error}</p>
          <button className="btn btn-ghost" type="button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : result?.patch ? (
        <>
          {result.truncated ? <div className="banner banner-warn">This large diff has been shortened.</div> : null}
          <pre className="diff-lines" aria-label={`${staged ? 'Staged' : 'Working tree'} changes to ${doc.path}`}>
            {result.patch.split('\n').map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith('@@')
                    ? 'diff-hunk'
                    : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
                      ? 'diff-meta'
                      : line.startsWith('+')
                        ? 'diff-line-add'
                        : line.startsWith('-')
                          ? 'diff-line-del'
                          : ''
                }
              >
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        </>
      ) : (
        <div className="panel-empty">
          <Icon name="check" size={24} />
          <h3>No {staged ? 'staged' : 'working tree'} changes</h3>
          <p>
            {status?.startsWith('?')
              ? 'This file is untracked. Open Code to see its contents.'
              : 'This file matches the version you are comparing against.'}
          </p>
        </div>
      )}
    </div>
  );
}
