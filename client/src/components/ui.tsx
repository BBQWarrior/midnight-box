import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { Disc3, Minus, Plus } from 'lucide-react';

// ---- Buttons -----------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ghost-danger';
export type ButtonSize = 'md' | 'sm' | 'icon';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
  secondary: 'border border-line bg-raised text-ink hover:border-faint/60',
  ghost: 'text-muted hover:bg-raised hover:text-ink',
  danger: 'border border-danger/30 bg-danger-soft text-danger hover:border-danger/60',
  'ghost-danger': 'text-danger hover:bg-danger-soft',
};
const sizes: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 text-sm',
  sm: 'min-h-9 px-3 text-[13px]',
  icon: 'size-11 shrink-0',
};

/** Classes for a button (or a link that looks like one). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-[background-color,border-color,filter,color] disabled:pointer-events-none disabled:opacity-45 ${variants[variant]} ${sizes[size]} ${extra}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

// ---- Surfaces ----------------------------------------------------------------

export function Card({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={`rounded-xl border border-line bg-surface ${className}`}>
      {children}
    </section>
  );
}

/** Title row of a card or section, with an optional line of help and actions on the right. */
export function Heading({
  title,
  description,
  actions,
  id,
  level = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  level?: 2 | 3;
}) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <H id={id} className={level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold'}>
          {title}
        </H>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', children, role }: { tone?: 'info' | 'danger'; children: ReactNode; role?: 'status' | 'alert' }) {
  const cls = tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-line bg-raised text-muted';
  return (
    <div role={role} className={`rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-6">{children}</div>;
}

// ---- Brand -------------------------------------------------------------------

export function Wordmark({ suffix, size = 'md' }: { suffix?: string; size?: 'md' | 'tv' }) {
  const tv = size === 'tv';
  return (
    <span className={`inline-flex items-center ${tv ? 'gap-[1.4vh]' : 'gap-2'}`}>
      <span
        aria-hidden="true"
        className={`flex items-center justify-center bg-accent text-accent-ink ${tv ? 'size-[4.6vh] rounded-[1vh]' : 'size-7 rounded-md'}`}
      >
        <Disc3 className={tv ? 'size-[3vh]' : 'size-[18px]'} strokeWidth={2.25} />
      </span>
      <span className={`font-bold tracking-tight ${tv ? 'text-[3.6vh]' : 'text-lg'}`}>
        Midnight Box
        {suffix && <span className="font-medium text-muted"> {suffix}</span>}
      </span>
    </span>
  );
}

// ---- Controls ----------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  disabled = false,
  labelledBy,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  labelledBy?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${
        checked ? 'border-accent bg-accent' : 'border-line bg-raised'
      }`}
    >
      <span
        className={`absolute left-0.5 size-[22px] rounded-full transition-transform ${
          checked ? 'translate-x-5 bg-accent-ink' : 'bg-muted'
        }`}
      />
    </button>
  );
}

/** A labelled row: text on the left, a control on the right. */
export function SettingRow({ label, help, children }: { label: ReactNode; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={id} className="text-sm">
          {label}
        </p>
        {help && <p className="mt-0.5 text-[13px] text-muted">{help}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2" aria-labelledby={id}>
        {children}
      </div>
    </div>
  );
}

/** A number with − and + buttons; typing works too. Calls onChange with a value inside [min, max]. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
    else setText(String(value));
  };
  const stepBtn = 'flex size-9 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink disabled:opacity-30';
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line bg-bg p-0.5">
      <button
        type="button"
        aria-label={`Less: ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className={stepBtn}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <label className="flex w-[4.75rem] items-baseline justify-center gap-1">
        <span className="sr-only">{label}</span>
        <input
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className={`${unit ? 'w-9 text-right' : 'w-full text-center'} bg-transparent text-sm font-semibold tabular-nums outline-none`}
        />
        {unit && <span className="w-7 text-xs text-muted">{unit}</span>}
      </label>
      <button
        type="button"
        aria-label={`More: ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className={stepBtn}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Segmented tabs (guest page) or a scrolling tab strip (host panel). */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  scroll = false,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  scroll?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(scroller, scroll);

  // Keep the selected tab in view when the strip scrolls.
  useEffect(() => {
    if (!scroll) return;
    scroller.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [scroll, value]);

  const buttons = tabs.map((t) => (
    <button
      key={t.id}
      type="button"
      role="tab"
      aria-selected={value === t.id}
      onClick={() => onChange(t.id)}
      className={`min-h-10 rounded-lg font-semibold whitespace-nowrap transition-colors ${
        scroll ? 'flex-auto shrink-0 px-2 text-[13px]' : 'flex-1 px-3 text-sm'
      } ${value === t.id ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}`}
    >
      {t.label}
    </button>
  ));

  if (!scroll) {
    return (
      <div role="tablist" aria-label={label} className="flex gap-1 rounded-xl border border-line bg-surface p-1">
        {buttons}
      </div>
    );
  }

  // Tabs that don't fit fade out at the edge instead of being cut off mid-word.
  const fade = (on: boolean) => (on ? '28px' : '0px');
  const mask = `linear-gradient(to right, transparent 0, #000 ${fade(edges.left)}, #000 calc(100% - ${fade(edges.right)}), transparent 100%)`;
  return (
    <div className="rounded-xl border border-line bg-surface p-1">
      <div
        ref={scroller}
        role="tablist"
        aria-label={label}
        className="no-scrollbar flex gap-0.5 overflow-x-auto"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {buttons}
      </div>
    </div>
  );
}

/** Whether a horizontally scrolling element has more content to the left and to the right. */
function useOverflowEdges(ref: RefObject<HTMLElement | null>, active: boolean): { left: boolean; right: boolean } {
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const update = (): void => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [ref, active]);
  return edges;
}
