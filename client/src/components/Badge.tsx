import type { ReactNode } from 'react';

const tones = {
  accent: 'bg-accent/25 text-violet-200 border-accent/40',
  cyan: 'bg-glow/15 text-cyan-200 border-glow/30',
  muted: 'bg-white/10 text-white/70 border-white/15',
  explicit: 'bg-white/15 text-white/80 border-white/20',
} as const;

export function Badge({ tone = 'muted', children, label }: { tone?: keyof typeof tones; children: ReactNode; label?: string }) {
  return (
    <span
      aria-label={label}
      className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
