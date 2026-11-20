import { Music } from 'lucide-react';
import type { Track } from '@shared/types';
import { hashString } from '../lib/format';

interface Props {
  track: Track;
  className?: string;
  iconSize?: number;
}

export function Cover({ track, className = 'size-12', iconSize = 20 }: Props) {
  if (track.imageUrl) {
    return (
      <img
        src={track.imageUrl}
        alt=""
        loading="lazy"
        className={`${className} shrink-0 rounded-lg bg-white/5 object-cover`}
      />
    );
  }
  const h = hashString(track.id);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >> 8) % 80)) % 360;
  return (
    <div
      aria-hidden="true"
      className={`${className} flex shrink-0 items-center justify-center rounded-lg text-white/80`}
      style={{ background: `linear-gradient(135deg, hsl(${hue1} 70% 45%), hsl(${hue2} 70% 30%))` }}
    >
      <Music size={iconSize} />
    </div>
  );
}
