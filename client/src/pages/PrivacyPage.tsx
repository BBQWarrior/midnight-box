import { useEffect, type ReactNode } from 'react';
import privacy from '../../../PRIVACY.md?raw';

type Block =
  | { kind: 'h1' | 'h2' | 'p'; text: string }
  | { kind: 'ul'; items: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = (): void => {
    if (para.length > 0) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = (): void => {
    if (list) blocks.push({ kind: 'ul', items: list });
    list = null;
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushPara();
      flushList();
    } else if (line.startsWith('## ')) {
      flushPara();
      flushList();
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
    } else if (line.startsWith('# ')) {
      flushPara();
      flushList();
      blocks.push({ kind: 'h1', text: line.slice(2).trim() });
    } else if (line.startsWith('- ')) {
      flushPara();
      if (!list) list = [];
      list.push(line.slice(2).trim());
    } else if (/^\s/.test(line) && list && list.length > 0) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(<strong key={key++}>{inline(m[1])}</strong>);
    } else if (m[2] !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-white/10 px-1 py-0.5 text-[0.9em]">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined && m[4] !== undefined) {
      if (/^https?:\/\//i.test(m[4])) {
        out.push(
          <a key={key++} href={m[4]} target="_blank" rel="noopener noreferrer" className="text-glow underline underline-offset-2">
            {m[3]}
          </a>,
        );
      } else {
        out.push(m[3]);
      }
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const blocks = parse(privacy);

export function PrivacyPage() {
  useEffect(() => {
    document.title = 'Midnight Box · Privacy';
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <a href="/" className="inline-flex min-h-11 items-center text-sm text-white/70 underline underline-offset-2">
        ← Back to Midnight Box
      </a>
      <main className="mt-2 text-base leading-relaxed text-white/85">
        {blocks.map((b, i) => {
          switch (b.kind) {
            case 'h1':
              return (
                <h1 key={i} className="mb-4 text-2xl font-bold text-white">
                  {inline(b.text)}
                </h1>
              );
            case 'h2':
              return (
                <h2 key={i} className="mb-2 mt-8 text-lg font-semibold text-white">
                  {inline(b.text)}
                </h2>
              );
            case 'p':
              return (
                <p key={i} className="mb-4">
                  {inline(b.text)}
                </p>
              );
            case 'ul':
              return (
                <ul key={i} className="mb-4 list-disc space-y-2 pl-5">
                  {b.items.map((it, j) => (
                    <li key={j}>{inline(it)}</li>
                  ))}
                </ul>
              );
          }
        })}
      </main>
    </div>
  );
}
