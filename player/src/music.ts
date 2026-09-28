// One track under the whole world. It steps back (by `underFilms`) while a film
// or a narration plays, and the visitor sets its level. Volume changes glide
// over a moment so they never click; the picture never fades.
import type { Music as MusicSpec } from './world';

const GLIDE_MS = 450;

export class Music {
  private readonly audio?: HTMLAudioElement;
  private level = 1; // the visitor's slider, 0..2 around the level as mixed
  private ducked = false;
  private muted = false;
  private glide = 0;

  constructor(private readonly spec: MusicSpec | null | undefined) {
    if (!spec) return;
    this.audio = new Audio(spec.src);
    this.audio.loop = true;
    this.audio.preload = 'auto';
    this.audio.volume = 0;
  }

  get present() {
    return Boolean(this.audio);
  }

  get credit() {
    return this.spec?.credit;
  }

  start() {
    if (!this.audio) return;
    void this.audio.play().catch(() => undefined);
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
    cancelAnimationFrame(this.glide);
    const from = audio.volume;
    const to = this.target();
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / GLIDE_MS);
      audio.volume = from + (to - from) * t;
      if (t < 1) this.glide = requestAnimationFrame(step);
    };
    this.glide = requestAnimationFrame(step);
  }
}
