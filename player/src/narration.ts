// A place tells itself as you arrive: its audio, one subtitle line at a time,
// each line timed by its start and end. Without audio (or with sound off) the
// lines show at reading pace. A film starting ends the narration. A close look
// is told the same way, by the same voice, while the world holds on it.
import { el } from './stage';
import type { Line, Place, Spoken, World } from './world';

export class Narration {
  private readonly box: HTMLElement;
  private readonly audio = new Audio();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private shown = -1;
  private lines: Line[] = [];
  private muted = false;
  private volume = 1;
  /** True from the moment audio starts until stop(); pausing fires one last timeupdate. */
  private speaking = false;
  /** Told when speaking starts and stops, so the music can step back. */
  onSpeaking?: (speaking: boolean) => void;
  /** Resolves the say() in progress. */
  private finished?: () => void;
  /** Counts stops, so a play() that was still starting when it was stopped does not fall back to reading aloud. */
  private generation = 0;

  constructor(parent: HTMLElement, private readonly world: World) {
    this.box = el('div', 'subtitle');
    this.box.setAttribute('role', 'status');
    this.box.hidden = true;
    parent.append(this.box);
    this.audio.preload = 'auto';
    this.audio.addEventListener('timeupdate', () => this.follow());
    this.audio.addEventListener('ended', () => this.stop());
  }

  /** The narration's element, so the Begin tap can unlock it (see Player.unlockMedia). */
  get element(): HTMLAudioElement {
    return this.audio;
  }

  start(place: Place, delayMs: number) {
    void this.say(place.narration, delayMs);
  }

  /** Speak these lines after `delayMs`; resolves when they have been said, or are stopped. */
  say(narration: Spoken | null | undefined, delayMs = 0): Promise<void> {
    this.stop();
    if (!narration?.lines.length) return Promise.resolve();
    this.lines = narration.lines;
    const done = new Promise<void>(resolve => { this.finished = resolve; });
    const generation = this.generation;
    this.timers.push(setTimeout(() => {
      if (narration.src && !this.muted) {
        this.audio.src = narration.src;
        this.audio.volume = this.volume;
        this.speaking = true;
        this.onSpeaking?.(true);
        this.audio.play().catch(() => { if (generation === this.generation) this.readAloud(); });
      } else this.readAloud();
    }, delayMs));
    return done;
  }

  stop() {
    this.generation++;
    this.speaking = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (!this.audio.paused) this.audio.pause();
    this.shown = -1;
    this.box.hidden = true;
    this.onSpeaking?.(false);
    const finished = this.finished;
    this.finished = undefined;
    finished?.();
  }

  setSound(volume: number, muted: boolean) {
    this.volume = volume;
    this.muted = muted;
    this.audio.volume = volume;
    this.audio.muted = muted; // only because the visitor turned sound off
  }

  /** Show the line whose time contains the audio's position. */
  private follow() {
    if (!this.speaking) return;
    const t = this.audio.currentTime;
    let index = -1;
    this.lines.forEach((line, i) => {
      if ((line.start ?? Infinity) <= t) index = i;
    });
    const line = this.lines[index];
    // A line stays up through the pause after it, unless it has clearly ended.
    if (line && line.end !== undefined && t > line.end + 1.2) index = -1;
    if (index !== this.shown) this.show(index);
  }

  /** No audio: each line for as long as it takes to read. */
  private readAloud() {
    let at = 0;
    this.lines.forEach((line, index) => {
      this.timers.push(setTimeout(() => this.show(index), at));
      at += Math.min(7000, Math.max(1800, 1200 + line.text.split(/\s+/).length * 320));
    });
    this.timers.push(setTimeout(() => this.stop(), at));
  }

  private show(index: number) {
    this.shown = index;
    const line = this.lines[index];
    if (!line) {
      this.box.hidden = true;
      return;
    }
    const speaker = line.speaker ?? '';
    const avatar = this.world.speakers?.[speaker]?.avatar;
    const who = el('span', 'who');
    if (avatar) {
      const img = el('img', 'avatar') as HTMLImageElement;
      img.src = avatar;
      img.alt = '';
      who.append(img);
    }
    if (speaker) who.append(el('span', 'name', `${speaker}:`));
    this.box.replaceChildren(who, el('span', 'words', line.text));
    this.box.hidden = false;
  }
}
