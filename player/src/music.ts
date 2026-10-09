// The music under the world: one track for the whole world, or a track per
// place that replaces it while you are there (a place with `music: null` is
// silent). It steps back (by `underFilms`) while a film or a narration plays,
// and the visitor sets its level. Volume changes glide over a moment so they
// never click; a change of track fades the old one out and the new one in.
// One audio element carries every track: iOS lets an element play on its own
// later only if it was played during a user gesture, so the element unlocked by
// the Begin tap is the one that keeps playing, whatever its source becomes.
import type { Music as MusicSpec, World } from './world';

const GLIDE_MS = 450;

/** Every credit the world's music carries, once each. */
export function musicCredits(world: World): string | undefined {
  const credits = [world.music?.credit, ...world.places.map(place => place.music?.credit)].filter((c): c is string => Boolean(c));
  return credits.length ? [...new Set(credits)].join(' · ') : undefined;
}

export class Music {
  private readonly audio?: HTMLAudioElement;
  private spec: MusicSpec | null = null;
  private started = false;
  private level = 1; // the visitor's slider, 0..2 around the level as mixed
  private ducked = false;
  private muted = false;
  private glide = 0;
  private swaps = 0;

  constructor(private readonly worldTrack: MusicSpec | null | undefined, world: World) {
    if (!worldTrack && !world.places.some(place => place.music)) return;
    this.audio = new Audio();
    this.audio.loop = true;
    this.audio.preload = 'auto';
    this.audio.volume = 0;
  }

  get present() {
    return Boolean(this.audio);
  }

  /** The track's element, so the Begin tap can unlock it (see Player.unlockMedia). */
  get element(): HTMLAudioElement | undefined {
    return this.audio;
  }

  /** The track a place plays: its own, the world's when it has none, nothing when it says null. */
  private trackFor(placeMusic: MusicSpec | null | undefined): MusicSpec | null {
    return placeMusic === undefined ? this.worldTrack ?? null : placeMusic;
  }

  /** Begin: start the first place's track. */
  start(placeMusic: MusicSpec | null | undefined) {
    this.started = true;
    this.spec = this.trackFor(placeMusic);
    this.play();
  }

  /** Arriving somewhere: keep the track if it is the same one, otherwise fade over to the place's. */
  switchTo(placeMusic: MusicSpec | null | undefined) {
    const next = this.trackFor(placeMusic);
    if (next?.src === this.spec?.src) { this.spec = next; this.update(); return; }
    this.spec = next;
    if (!this.started || !this.audio) return;
    const swap = ++this.swaps;
    if (!this.audio.src || this.audio.paused) { this.play(); return; }
    this.fade(0, () => { if (swap === this.swaps) this.play(); });
  }

  private play() {
    const audio = this.audio;
    if (!audio || !this.started) return;
    if (!this.spec) { audio.pause(); audio.removeAttribute('src'); return; }
    audio.src = this.spec.src;
    audio.volume = 0;
    void audio.play().catch(() => undefined);
    this.update();
  }

  setLevel(level: number) {
    this.level = level;
    this.update();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.update();
  }

  duck(on: boolean) {
    this.ducked = on;
    this.update();
  }

  private target() {
    if (!this.spec || this.muted) return 0;
    const under = this.ducked ? this.spec.underFilms ?? 0.5 : 1;
    return Math.min(1, Math.max(0, (this.spec.volume ?? 1) * 0.5 * this.level * under));
  }

  private update() {
    const audio = this.audio;
    if (!audio) return;
    // iOS ignores a media element's volume, so sound off must also mute it;
    // the glide below still ducks and levels the music everywhere else.
    audio.muted = this.muted;
    this.fade(this.target());
  }

  private fade(to: number, done?: () => void) {
    const audio = this.audio;
    if (!audio) return;
    cancelAnimationFrame(this.glide);
    const from = audio.volume;
    const began = performance.now();
    const step = (now: number) => {
      // A frame's timestamp can be a little earlier than `began`, and a
      // negative step would fade below zero, which the browser refuses.
      const t = Math.min(1, Math.max(0, (now - began) / GLIDE_MS));
      audio.volume = Math.min(1, Math.max(0, from + (to - from) * t));
      if (t < 1) this.glide = requestAnimationFrame(step);
      else done?.();
    };
    this.glide = requestAnimationFrame(step);
  }
}
