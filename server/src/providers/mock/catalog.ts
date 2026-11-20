import type { Track } from '@shared/types';

/** Entirely fictional artists and songs for demo mode. */
const ARTISTS: { name: string; album: string; songs: [title: string, seconds: number, explicit?: boolean][] }[] = [
  { name: 'Neon Harbor', album: 'Low Tide Lights', songs: [['Afterglow Avenue', 214], ['Saltwater Static', 187], ['Pier 9 at 2AM', 241]] },
  { name: 'The Velvet Satellites', album: 'Orbit Sessions', songs: [['Gravity Waltz', 198], ['Moonbase Lullaby', 226], ['Signal Lost', 175, true]] },
  { name: 'Juno Park', album: 'Paper Planets', songs: [['Cardboard Rocket', 163], ['Sunday Supernova', 207], ['Origami Heart', 189]] },
  { name: 'Midnight Cartographers', album: 'Maps of Nowhere', songs: [['North of Never', 252], ['Compass Rose', 199], ['Uncharted', 233]] },
  { name: 'Lola Ferro', album: 'Copper Wire', songs: [['Electric Avenue Café', 181], ['Fuse Box Romance', 204, true], ['Short Circuit', 158]] },
  { name: 'Glasshouse Choir', album: 'Prism', songs: [['Refraction', 219], ['Stained Light', 244], ['Kaleidoscope Eyes', 192]] },
  { name: 'Dex Okafor', album: 'Night Bus Diaries', songs: [['Last Stop', 176, true], ['Route 42', 201], ['Window Seat', 188]] },
  { name: 'Aurora Static', album: 'Polar Frequencies', songs: [['Magnetic North', 237], ['Snowblind Radio', 209], ['Ice Cathedral', 262]] },
  { name: 'The Sleepless Owls', album: 'Nocturne Club', songs: [['3AM Philosophy', 194], ['Insomnia Disco', 211, true], ['Feathers & Neon', 183]] },
  { name: 'Mira Solenne', album: 'Halcyon', songs: [['Golden Hour Ghosts', 228], ['Seaglass', 196], ['Lantern Festival', 215]] },
  { name: 'Turbo Lagoon', album: 'Synth Safari', songs: [['Crocodile Arcade', 172], ['Jungle Mainframe', 205], ['Palm Tree Protocol', 190]] },
  { name: 'Kit & the Comets', album: 'Tailspin', songs: [['Shooting Star Shuffle', 167], ['Comet Tail', 199], ['Rocket Fuel Love', 184]] },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const MOCK_CATALOG: Track[] = ARTISTS.flatMap((artist) =>
  artist.songs.map(([title, seconds, explicit]) => {
    const id = `mock:${slug(artist.name)}:${slug(title)}`;
    return {
      id,
      uri: `mock:track:${id.slice(5)}`,
      name: title,
      artists: [{ id: `mock:${slug(artist.name)}`, name: artist.name }],
      album: artist.album,
      imageUrl: null,
      durationMs: seconds * 1000,
      explicit: explicit ?? false,
    } satisfies Track;
  }),
);
