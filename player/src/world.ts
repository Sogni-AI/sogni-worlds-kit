// world.json: the finished world (format reference: docs/world-json.md).
// Media paths are relative to the world.json file, or absolute URLs.

export type Film = { src: string; src720?: string; seconds?: number };
export type Outline = { width: number; height: number; path: string };
export type Hotspot = {
  id: string;
  label: string;
  hint?: string;
  at: [number, number];
  outline?: Outline | null;
  /** The place a crossing lands on; null or absent for a moment that returns here. */
  to?: string | null;
  next?: boolean;
  shortcut?: boolean;
  film: Film;
  rewind?: Film | null;
};
export type Line = { text: string; speaker?: string; start?: number; end?: number };
export type Place = {
  id: string;
  title: string;
  chapter?: string;
  caption?: string;
  still: string;
  loop?: Film | null;
  narration?: { src?: string; lines: Line[] } | null;
  hotspots: Hotspot[];
};
export type Music = { src: string; volume?: number; underFilms?: number; credit?: string };
export type World = {
  format: 'sogni-world@1';
  id: string;
  title: string;
  subtitle?: string;
  credit?: string;
  aspect: { width: number; height: number };
  start: string;
  order?: string[] | null;
  music?: Music | null;
  speakers?: Record<string, { avatar?: string }>;
  places: Place[];
};

export type Quality = '720' | '2k';

/** ?world=<url> wins; then the dev server's default; then ./world.json beside the page. */
export function worldUrl(): string {
  const asked = new URLSearchParams(location.search).get('world');
  return new URL(asked || import.meta.env.VITE_DEFAULT_WORLD || './world.json', location.href).href;
}

export async function loadWorld(url: string): Promise<World> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  const world = (await response.json()) as World;
  if (world.format !== 'sogni-world@1') throw new Error(`${url} is not a sogni-world@1 file.`);
  const at = (path: string) => new URL(path, url).href;
  const film = (f: Film): Film => ({ ...f, src: at(f.src), ...(f.src720 ? { src720: at(f.src720) } : {}) });
  const ids = new Set(world.places.map(place => place.id));
  if (!ids.has(world.start)) throw new Error(`The start place "${world.start}" is not in the world.`);
  for (const place of world.places) {
    place.still = at(place.still);
    if (place.loop) place.loop = film(place.loop);
    if (place.narration?.src) place.narration.src = at(place.narration.src);
    for (const spot of place.hotspots) {
      if (spot.to && !ids.has(spot.to)) throw new Error(`${place.id}/${spot.id} leads to "${spot.to}", which is not a place.`);
      spot.film = film(spot.film);
      if (spot.rewind) spot.rewind = film(spot.rewind);
    }
  }
  if (world.music) world.music.src = at(world.music.src);
  for (const speaker of Object.values(world.speakers ?? {})) if (speaker.avatar) speaker.avatar = at(speaker.avatar);
  return world;
}

export const pick = (film: Film, quality: Quality) => (quality === '720' && film.src720 ? film.src720 : film.src);

export const placeOf = (world: World, id: string) => {
  const place = world.places.find(p => p.id === id);
  if (!place) throw new Error(`No place "${id}".`);
  return place;
};

/** The way on to the next stop, in a story told in order. */
export const nextStop = (place: Place) => place.hotspots.find(spot => spot.next && spot.to);
