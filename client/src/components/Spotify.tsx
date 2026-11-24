import type { CSSProperties, ReactNode } from 'react';
import type { Track } from '@shared/types';
import spotifyLogo from '../assets/spotify/Full_Logo_White_RGB.svg';
import { Cover } from './Cover';

export const trackUrl = (track: Track): string => `https://open.spotify.com/track/${track.id}`;
export const artistUrl = (artistId: string): string => `https://open.spotify.com/artist/${artistId}`;

/**
 * Full Spotify logo (white), unmodified. Phone pages: 84px wide (never under 70px).
 * TV: 4.5vh high (about 117px wide at 720p). The wrapper padding is the clear space
 * (half the icon height) the branding guidelines ask for.
 */
export function SpotifyLogo({ tv = false }: { tv?: boolean }) {
  const style: CSSProperties = tv ? { height: '4.5vh', width: 'auto' } : { width: 84, height: 'auto' };
  return (
    <span className={`inline-flex ${tv ? 'p-[2.25vh]' : 'p-3'}`}>
      <img src={spotifyLogo} alt="Spotify" style={style} className="block max-w-none" />
    </span>
  );
}

interface ExtLinkProps {
  href: string;
  className?: string;
  title?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export function ExtLink({ href, children, ...rest }: ExtLinkProps) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

/** The link-back text the guidelines allow. */
export function OpenSpotifyLink({ track, className = '' }: { track: Track; className?: string }) {
  return (
    <ExtLink
      href={trackUrl(track)}
      className={`font-bold uppercase tracking-wider text-white underline-offset-4 hover:underline ${className}`}
    >
      Open Spotify
    </ExtLink>
  );
}

interface CoverLinkProps {
  track: Track;
  /** False in demo mode (fake ids): renders the plain cover. */
  spotify: boolean;
  className?: string;
  iconSize?: number;
  rounded?: string;
}

/** Cover art that links to the track on Spotify. Never put it inside another link or button. */
export function CoverLink({ track, spotify, className, iconSize, rounded }: CoverLinkProps) {
  const cover = (
    <Cover
      track={track}
      {...(className ? { className } : {})}
      {...(iconSize ? { iconSize } : {})}
      {...(rounded ? { rounded } : {})}
    />
  );
  if (!spotify) return cover;
  return (
    <ExtLink href={trackUrl(track)} aria-label={`Open ${track.name} on Spotify`} className="shrink-0">
      {cover}
    </ExtLink>
  );
}
