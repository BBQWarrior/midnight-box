import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/api';

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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-midnight-950/90 p-5 backdrop-blur-md">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl"
      >
        <h1 className="text-2xl font-bold">What should we call you?</h1>
        <p className="mt-1 text-sm text-white/60">Your name shows next to the songs you add.</p>
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
          className="mt-5 h-12 w-full rounded-xl border border-white/15 bg-white/5 px-4 text-base text-white placeholder:text-white/40"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-3">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="min-h-12 flex-1 rounded-xl border border-white/15 font-medium"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="min-h-12 flex-1 rounded-xl bg-linear-to-r from-accent to-accent-2 font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
