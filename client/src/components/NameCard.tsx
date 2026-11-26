import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';
import { Button, Wordmark } from './ui';

interface Props {
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel?: () => void;
}

export function NameCard({ initialName = '', onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg/95 p-5">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-2xl shadow-black/50"
      >
        <Wordmark />
        <h1 className="mt-6 text-2xl font-bold tracking-tight">What should we call you?</h1>
        <p className="mt-1 text-sm text-muted">Your name shows next to the songs you add.</p>
        <p className="mt-1 text-xs text-faint">
          Your nickname is stored on the host&apos;s computer.{' '}
          <a href="/privacy" className="underline underline-offset-2">
            Privacy
          </a>
        </p>
        <label htmlFor="guest-name" className="sr-only">
          Your name
        </label>
        <input
          id="guest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          autoFocus
          autoComplete="nickname"
          placeholder="Your name"
          className="mt-5 h-12 w-full rounded-lg border border-line bg-bg px-4 text-base text-ink placeholder:text-faint focus:border-faint"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-3">
          {onCancel && (
            <Button className="min-h-12 flex-1" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" className="min-h-12 flex-1" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </form>
    </div>
  );
}
