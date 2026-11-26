import type { ReactNode } from 'react';

const tones = {
  accent: 'bg-accent-soft text-accent',
  muted: 'bg-raised text-muted',
  explicit: 'border border-faint/60 text-muted',
} as const;

/** A small label next to a song: "You", "Vote pick", "Up next", "E". */
export function Badge({ tone = 'muted', children, label }: { tone?: keyof typeof tones; children: ReactNode; label?: string }) {
  return (
    <span
      aria-label={label}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-[3px] text-[11px] font-semibold leading-none ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
