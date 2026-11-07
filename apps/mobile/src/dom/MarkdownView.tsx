'use dom';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IS_DOM, type DOMProps } from 'expo/dom';
import { copyToClipboard, cssVars, type DomThemeName } from './domTheme';

export interface MarkdownViewProps {
  text: string;
  streaming: boolean;
  theme: DomThemeName;
  /** compact mode for thoughts / previews */
  muted?: boolean;
  onOpenLink?: (href: string) => Promise<void>;
  dom?: DOMProps;
}

const CSS = `
  .mide-md, .mide-md * { box-sizing: border-box; }
  .mide-md { font-family: var(--sans); font-size: 16px; line-height: 1.65; color: var(--text); word-wrap: break-word; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
  .mide-md.muted { color: var(--text-muted); font-size: 14px; }
  .mide-md > :first-child { margin-top: 0; }
  .mide-md > :last-child { margin-bottom: 0; }
  .mide-md p { margin: 0 0 14px; }
  .mide-md ul, .mide-md ol { margin: 0 0 14px; padding-left: 24px; }
  .mide-md li { margin: 5px 0; }
  .mide-md li > p { margin: 0; }
  .mide-md h1, .mide-md h2, .mide-md h3, .mide-md h4 { margin: 22px 0 10px; line-height: 1.35; font-weight: 650; letter-spacing: -0.02em; }
  .mide-md h1 { font-size: 24px; }
  .mide-md h2 { font-size: 21px; }
  .mide-md h3 { font-size: 18px; }
  .mide-md h4 { font-size: 16px; }
  .mide-md a { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
  .mide-md a:active { opacity: .7; }
  .mide-md blockquote { margin: 0 0 14px; padding: 6px 16px; border-left: 2px solid var(--border-strong); color: var(--text-muted); }
  .mide-md blockquote > :last-child { margin-bottom: 0; }
  .mide-md hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
  .mide-md code { font-family: var(--mono); font-size: .84em; background: var(--surface-alt); color: var(--code-text); padding: 2px 5px; border-radius: 4px; }
  .mide-md .code-block { margin: 0 0 16px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .mide-md .code-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 44px; padding-left: 14px; background: var(--surface-alt); border-bottom: 1px solid var(--border); }
  .mide-md .lang { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
  .mide-md pre { margin: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .mide-md pre code { display: block; padding: 14px; background: transparent; border-radius: 0; font-size: 12.5px; line-height: 1.65; white-space: pre; }
  .mide-md .copy { min-height: 44px; min-width: 64px; padding: 0 12px; border: 0; background: transparent; color: var(--text-muted); font: 600 12px var(--sans); cursor: pointer; }
  .mide-md .copy:active { background: var(--surface-pressed); }
  .mide-md .copy:focus-visible, .mide-md a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .mide-md table { border-collapse: collapse; margin: 0 0 16px; display: block; overflow-x: auto; max-width: 100%; font-size: 14px; }
  .mide-md th, .mide-md td { border: 1px solid var(--border); padding: 9px 12px; text-align: left; vertical-align: top; }
  .mide-md th { background: var(--surface-alt); font-weight: 600; }
  .mide-md img { max-width: 100%; border-radius: 12px; }
  .mide-md input[type=checkbox] { margin-right: 8px; vertical-align: middle; accent-color: var(--accent); }
  .mide-md .cursor { display: inline-block; width: 6px; height: 16px; margin-left: 3px; vertical-align: -2px; background: var(--accent); border-radius: 2px; animation: mide-cursor-blink 1s steps(2) infinite; }
  @keyframes mide-cursor-blink { to { visibility: hidden; } }
  @media (prefers-reduced-motion: reduce) { .mide-md .cursor { animation: none; } }
`;
const DOCUMENT_CSS = IS_DOM ? 'html, body { margin: 0; padding: 0; background: transparent; }' : '';

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
  const text = String(children ?? '').replace(/\n$/, '');
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="lang">{lang ?? 'Code'}</span>
        <button
          type="button"
          className="copy"
          aria-label="Copy code"
          onClick={async () => {
            setCopyState((await copyToClipboard(text)) ? 'copied' : 'failed');
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopyState('idle'), 1800);
          }}
        >
          <span role="status">{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Try again' : 'Copy'}</span>
        </button>
      </div>
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

export default function MarkdownView({ text, streaming, theme, muted, onOpenLink }: MarkdownViewProps) {
  const components = useMemo(
    () => ({
      pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      code: ({
        className,
        children,
        node,
      }: {
        className?: string;
        children?: React.ReactNode;
        node?: { position?: { start: { line: number }; end: { line: number } } };
      }) => {
        const multiline = String(children ?? '').includes('\n') || (node?.position && node.position.start.line !== node.position.end.line);
        if (multiline || className) return <CodeBlock className={className}>{children}</CodeBlock>;
        return <code>{children}</code>;
      },
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <a
          href={href}
          onClick={(e) => {
            if (onOpenLink && href) {
              e.preventDefault();
              void onOpenLink(href);
            }
          }}
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      ),
    }),
    [onOpenLink],
  );

  return (
    <div className={`mide-md${muted ? ' muted' : ''}`}>
      <style>{`.mide-md{${cssVars(theme)}}${DOCUMENT_CSS}${CSS}`}</style>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
      {streaming ? <span className="cursor" aria-hidden /> : null}
    </div>
  );
}
