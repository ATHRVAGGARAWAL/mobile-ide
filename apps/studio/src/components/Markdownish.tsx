/** A small, safe renderer for assistant prose: paragraphs, fenced code, inline code, bold/italic, bullets, headings. */
import { Fragment, type ReactNode } from 'react';

interface Block {
  kind: 'code' | 'para' | 'list' | 'heading';
  text: string;
  lang?: string;
  level?: number;
  items?: string[];
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) (buf.push(lines[i] ?? ''), i++);
      i++;
      out.push({ kind: 'code', text: buf.join('\n'), lang });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: 'heading', text: heading[2] ?? '', level: heading[1]!.length });
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i] ?? ''))
        (items.push((lines[i] ?? '').replace(/^\s*([-*•]|\d+[.)])\s+/, '')), i++);
      out.push({ kind: 'list', text: '', items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] ?? '') &&
      !/^\s*(```|~~~)/.test(lines[i] ?? '') &&
      !/^(#{1,6})\s+/.test(lines[i] ?? '') &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i] ?? '')
    )
      (buf.push(lines[i] ?? ''), i++);
    out.push({ kind: 'para', text: buf.join('\n') });
  }
  return out;
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('`')) nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return nodes;
}

export function Markdownish({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              <pre key={i} className="md-code" data-lang={b.lang}>
                <code>{b.text}</code>
              </pre>
            );
          case 'heading':
            return (
              <div key={i} className={`md-h md-h${Math.min(b.level ?? 1, 3)}`}>
                {inline(b.text)}
              </div>
            );
          case 'list':
            return (
              <ul key={i}>
                {(b.items ?? []).map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          default:
            return <p key={i}>{inline(b.text)}</p>;
        }
      })}
    </div>
  );
}
