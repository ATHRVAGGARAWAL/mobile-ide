'use dom';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IS_DOM, type DOMProps } from 'expo/dom';
import type { HighlighterCore, ThemedToken } from 'shiki/core';
import { cssVars, paletteFor, type DomThemeName } from './domTheme';

export interface CodeViewProps {
  code: string;
  language: string;
  theme: DomThemeName;
  wrap: boolean;
  highlightLine?: number;
  fontSize?: number;
  dom?: DOMProps;
}

const CSS = `
  .mide-code, .mide-code * { box-sizing: border-box; }
  .mide-code { font-family: var(--mono); line-height: 1.65; color: var(--code-text); background: var(--code-bg); min-height: 100%; padding: 12px 0 24px; }
  .mide-code .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .mide-code table { border-collapse: collapse; }
  .mide-code td { padding: 0 16px 0 0; vertical-align: top; white-space: pre; }
  .mide-code.wrap td.src { white-space: pre-wrap; overflow-wrap: anywhere; }
  .mide-code.wrap table { width: 100%; }
  .mide-code td.ln { text-align: right; color: var(--text-faint); user-select: none; -webkit-user-select: none; padding: 0 14px 0 12px; width: 1%; min-width: 48px; position: sticky; left: 0; background: var(--code-bg); border-right: 1px solid var(--border); }
  .mide-code td.src { padding-left: 14px; }
  .mide-code tr.hl td { background: var(--accent-soft); }
  .mide-code tr.hl td.ln { color: var(--accent); font-weight: 600; }
  .mide-code .status { font-family: var(--sans); font-size: 12px; color: var(--text-muted); padding: 8px 16px; }
`;
const DOCUMENT_CSS = IS_DOM ? 'html, body { margin: 0; background: transparent; }' : '';

function codeTheme(theme: DomThemeName) {
  const c = paletteFor(theme);
  return {
    name: `mide-${theme}`,
    type: theme,
    colors: { 'editor.background': c.codeBg, 'editor.foreground': c.codeText },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.textFaint, fontStyle: 'italic' } },
      { scope: ['keyword', 'storage', 'constant.language'], settings: { foreground: c.accent } },
      { scope: ['entity.name.function', 'entity.name.type', 'support.function'], settings: { foreground: c.text, fontStyle: 'bold' } },
      { scope: ['string', 'constant.numeric'], settings: { foreground: c.textMuted } },
    ],
  };
}

const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  htm: 'html',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  kt: 'kotlin',
  plaintext: 'text',
  txt: 'text',
  dockerfile: 'dockerfile',
  Dockerfile: 'dockerfile',
  makefile: 'makefile',
  Makefile: 'makefile',
  jsonc: 'json',
  json5: 'json',
  toml: 'toml',
};

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  yaml: () => import('@shikijs/langs/yaml'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  xml: () => import('@shikijs/langs/xml'),
  ini: () => import('@shikijs/langs/ini'),
  makefile: () => import('@shikijs/langs/makefile'),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighterCore({
        themes: [codeTheme('dark'), codeTheme('light')],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return highlighterPromise;
}

async function ensureLang(hl: HighlighterCore, lang: string): Promise<boolean> {
  if (lang === 'text') return false;
  if (loadedLangs.has(lang)) return true;
  const loader = LOADERS[lang];
  if (!loader) return false;
  const mod = await loader();
  await hl.loadLanguage(...(mod.default as Parameters<HighlighterCore['loadLanguage']>));
  loadedLangs.add(lang);
  return true;
}

const MAX_HIGHLIGHT_CHARS = 300_000;

export default function CodeView({ code, language, theme, wrap, highlightLine, fontSize = 12.5 }: CodeViewProps) {
  const lang = LANG_ALIASES[language] ?? language.toLowerCase();
  const plainLines = useMemo(() => {
    const lines = code.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a trailing newline ends the last line, it does not start one
    return lines;
  }, [code]);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const hlRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    if (code.length > MAX_HIGHLIGHT_CHARS) {
      setStatus('Large file: syntax highlighting skipped');
      return;
    }
    (async () => {
      try {
        const hl = await getHighlighter();
        const ok = await ensureLang(hl, lang);
        if (cancelled) return;
        if (!ok) {
          setStatus(null);
          return;
        }
        const result = hl.codeToTokens(code, { lang, theme: `mide-${theme}` });
        if (!cancelled) {
          setTokens(result.tokens);
          setStatus(null);
        }
      } catch (err) {
        console.warn('[code] highlight failed', err);
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  useEffect(() => {
    if (highlightLine && hlRef.current) {
      try {
        hlRef.current.scrollIntoView({ block: 'center' });
      } catch {
        /* ignore */
      }
    }
  }, [highlightLine, tokens]);

  const lineCount = plainLines.length;
  return (
    <div className={`mide-code${wrap ? ' wrap' : ''}`} style={{ fontSize }}>
      <style>{`.mide-code{${cssVars(theme)}}${DOCUMENT_CSS}${CSS}`}</style>
      {status ? <div className="status">{status}</div> : null}
      <div className="scroll">
        <table>
          <tbody>
            {Array.from({ length: lineCount }, (_, i) => {
              const n = i + 1;
              const hl = n === highlightLine;
              const toks = tokens?.[i];
              return (
                <tr key={n} className={hl ? 'hl' : undefined} ref={hl ? hlRef : undefined} id={`L${n}`}>
                  <td className="ln">{n}</td>
                  <td className="src">
                    {toks
                      ? toks.map((tk, j) => (
                          <span
                            key={j}
                            style={{
                              color: tk.color,
                              fontStyle: (tk.fontStyle ?? 0) & 1 ? 'italic' : undefined,
                              fontWeight: (tk.fontStyle ?? 0) & 2 ? 700 : undefined,
                            }}
                          >
                            {tk.content}
                          </span>
                        ))
                      : plainLines[i] || ' '}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
