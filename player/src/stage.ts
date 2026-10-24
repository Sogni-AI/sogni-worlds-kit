// The picture: one place shown whole at the world's shape, a blurred copy of
// the same moving picture filling the screen behind it, and the films that
// carry you between places.
//
// Layers inside the frame, bottom to top: the still (a fallback and the poster),
// the two loop elements, the two film elements. A place is shown with video
// frames whenever it has a loop, because a JPEG and a video decode to slightly
// different colours and the films start and end on video frames. Films take
// turns on two elements for the same reason: a close look is held on its
// film's last frame, and the film back from it replaces that frame only once
// its own first frame (the same picture) is on screen.
import { LoopDeck } from './loop-deck';
import { bufferedFraction, playWithSound, release, setSource, watchStall, whenEnded, whenPainted } from './media';
import { localOrRemote } from './video-cache';
import { pick, type Film, type Place, type Quality, type World } from './world';

export class Stage {
  readonly frame: HTMLElement;
  readonly overlay: HTMLElement;
  private readonly still: HTMLImageElement;
  private readonly deck: LoopDeck;
  private readonly films: [HTMLVideoElement, HTMLVideoElement];
  private filmIndex = 0;
  private readonly backdropVideo: HTMLVideoElement;
  private readonly backdropStill: HTMLImageElement;
  private following: HTMLVideoElement | null = null;
  private volume = 1;
  private muted = false;
  quality: Quality = '2k';
  /** The film on screen, while one plays. */
  private playing: Film | null = null;
  /** Ends the film that is playing where it is (Skip pressed before it could even start). */
  private abandon?: () => void;
  /** Counts films and places put up, so a landed film waiting for its still is not hidden over something newer. */
  private handovers = 0;
  /** Told when the playing film is starved of bytes (and when it flows again), with how much of it has arrived. */
  onStall?: (stalled: boolean, loaded: number | null) => void;
  /**
   * Told when something outside the world pauses the playing film (a media
   * key, a headset button, AirPods taken out, the browser itself), and when it
   * plays again. Nothing in the world would play it on: it would wait for an
   * end it never reaches.
   */
  onInterrupted?: (interrupted: boolean) => void;

  constructor(root: HTMLElement, world: World) {
    const backdrop = el('div', 'backdrop');
    this.backdropStill = el('img', 'backdrop-still') as HTMLImageElement;
    this.backdropStill.alt = '';
    // The one muted element: a silent, blurred duplicate of the picture that is
    // already playing with sound in front of it. Its sound would double the audio.
    this.backdropVideo = el('video', 'backdrop-video') as HTMLVideoElement;
    this.backdropVideo.muted = true;
    this.backdropVideo.playsInline = true;
    this.backdropVideo.loop = true;
    this.backdropVideo.setAttribute('aria-hidden', 'true');
    backdrop.append(this.backdropStill, this.backdropVideo);

    this.frame = el('div', 'frame');
    this.frame.style.setProperty('--aspect', `${world.aspect.width} / ${world.aspect.height}`);
    this.frame.style.setProperty('--ratio', String(world.aspect.width / world.aspect.height));
    // The page knows the picture's shape too, so what sits below the picture can find its edge.
    root.style.setProperty('--ratio', String(world.aspect.width / world.aspect.height));
    this.still = el('img', 'layer still') as HTMLImageElement;
    this.still.alt = '';
    this.frame.append(this.still);
    this.deck = new LoopDeck(this.frame);
    this.deck.onShow = video => this.follow(video);
    const film = () => {
      const video = el('video', 'layer film') as HTMLVideoElement;
      video.playsInline = true;
      video.preload = 'auto';
      this.frame.append(video);
      return video;
    };
    this.films = [film(), film()];
    this.overlay = el('div', 'overlay');
    this.frame.append(this.overlay);

    root.append(backdrop, this.frame);
    setInterval(() => this.sync(), 500);
  }

  /** The film element in use: the one playing, or holding a close look. */
  private get film(): HTMLVideoElement {
    return this.films[this.filmIndex];
  }

  /** Every media element the stage plays, for the Begin tap to unlock. */
  get mediaElements(): HTMLMediaElement[] {
    return [...this.deck.videos, ...this.films, this.backdropVideo];
  }

  /** Show a place at once: its still, then its living loop from the first frame. */
  async show(place: Place) {
    this.handovers++;
    this.setStill(place);
    this.hideFilm();
    if (place.loop) await this.deck.start(localOrRemote(pick(place.loop, this.quality)));
    else {
      this.deck.stop();
      this.follow(null);
    }
  }

  /**
   * Play a film full-frame with its sound and land on `landing`. The film's last
   * frame is the landing place's first picture, so the switch to that place's
   * loop is a straight cut between identical frames.
   */
  async play(film: Film, landing: Place) {
    // Get the landing ready while the film plays (in the quality it ends in).
    const landingLoop = () => (landing.loop ? localOrRemote(pick(landing.loop, this.quality)) : null);
    await this.roll(film, () => { if (landingLoop()) this.deck.load(landingLoop()!); });
    this.setStill(landing);
    const loopSrc = landingLoop();
    this.handOver(loopSrc ? await this.deck.start(loopSrc) : false);
  }

  /**
   * Take a landed film down once what replaces it can be drawn: the loop's
   * first frame, or else the still, decoded. The film's last frame is that
   * same picture, so it stays up until then. A still put up before its pixels
   * arrive shows the place just left (the <img> keeps its old picture while
   * the new one loads): 0.6 s from Sogni's CDN, and the whole wait on a slow
   * link. The place's objects come up meanwhile, over the same picture.
   */
  private handOver(loopPainted: boolean) {
    const turn = ++this.handovers;
    const down = () => {
      if (turn !== this.handovers) return;
      if (!this.deck.visible) this.follow(null);
      this.hideFilm();
    };
    if (loopPainted) down();
    else void this.still.decode().catch(() => undefined).then(down);
  }

  /**
   * Play a film into a close look and stay there: its last frame (the reveal
   * still) holds on screen, still, until the next film replaces it. Nothing
   * moves behind a figure being turned over or a line being said.
   */
  async playToHold(film: Film, still: string) {
    await this.roll(film);
    this.setStill({ still });
    // Held on the film's last frame; if it never played, on the close look's own picture.
    this.deck.stop();
    if (this.film.classList.contains('on')) this.follow(this.film);
    else {
      this.hideFilm(); // a landed film still waiting for its place's still
      this.follow(null);
    }
  }

  /**
   * Run one film on the film element not in use, and make it the one on screen
   * once its first frame is painted (the place, or the held close look, stays
   * until then). Resolves on its last frame, which stays on screen.
   */
  private async roll(film: Film, whilePlaying?: () => void) {
    this.handovers++; // a landed film still up is replaced by this one's first frame
    const previous = this.film;
    this.filmIndex = 1 - this.filmIndex;
    const video = this.film;
    this.playing = film;
    setSource(video, localOrRemote(pick(film, this.quality)));
    video.currentTime = 0;
    this.applyVolume();
    // A slow connection never skips the film: the place stays on screen until
    // the first frame has arrived, the visitor is told while it is starved, and
    // it plays through. Skip stays theirs to press.
    const report = (value: boolean) => { video.classList.toggle('stalled', value); this.onStall?.(value, bufferedFraction(video)); };
    const stop = watchStall(video, report);
    const loaded = () => { if (video.classList.contains('stalled')) this.onStall?.(true, bufferedFraction(video)); };
    video.addEventListener('progress', loaded);
    void playWithSound(video);
    let given = false;
    const abandoned = new Promise<void>(resolve => { this.abandon = () => { given = true; resolve(); }; });
    await Promise.race([whenPainted(video, Infinity), abandoned]);
    // Given up before its first frame: nothing of it is shown; the caller lands where the film would have.
    if (!given) {
      video.classList.add('on');
      previous.classList.remove('on');
      previous.pause();
      this.deck.stop();
      this.follow(video);
      whilePlaying?.();
      // The player never pauses a film that is playing; its own last frame pauses it as `ended`.
      const paused = () => { if (!video.ended) this.onInterrupted?.(true); };
      const resumed = () => this.onInterrupted?.(false);
      video.addEventListener('pause', paused);
      video.addEventListener('playing', resumed);
      await Promise.race([this.untilEnded(), abandoned]);
      video.removeEventListener('pause', paused);
      video.removeEventListener('playing', resumed);
      this.onInterrupted?.(false);
    } else release(video); // and stop fetching it: the place it was skipped to needs the connection
    this.abandon = undefined;
    stop();
    video.removeEventListener('progress', loaded);
    video.classList.remove('stalled');
    this.onStall?.(false, null);
    this.playing = null;
  }

  /**
   * Hold the place still (and its sound with it) while something covers it, a
   * figure being turned over: a living picture moving behind a dialog reads as
   * chaos. `false` lets it live again from where it stopped.
   */
  freeze(on: boolean) {
    if (on) this.deck.pause();
    else this.deck.resume();
  }

  /** The place's own sound steps back while the narrator speaks (where the browser lets a page set a volume). */
  duckLoop(on: boolean) {
    this.deck.duck(on);
  }

  /**
   * Wait for the film's last frame. A load error on a slow or dropped
   * connection is retried once from where it was; only a second failure
   * ends the film where it is, so a broken file never strands the visitor.
   */
  private async untilEnded() {
    let retried = false;
    for (;;) {
      await whenEnded(this.film);
      if (this.film.ended || retried || !this.film.error) return;
      retried = true;
      const at = this.film.currentTime;
      this.film.load();
      this.film.currentTime = at;
      void playWithSound(this.film);
    }
  }

  /**
   * Jump to the end of the film that is playing (its last frame is the
   * landing); one that has not loaded enough to know its length is given up,
   * so a film that never arrives cannot strand the visitor. A held close
   * look is not a film: Skip leaves it alone.
   */
  skip() {
    if (!this.playing) return;
    if (Number.isFinite(this.film.duration)) {
      this.film.currentTime = Math.max(0, this.film.duration - 0.05);
      // Paused from outside, it would sit just short of its end: Skip plays it there.
      if (this.film.paused) void playWithSound(this.film);
    } else this.abandon?.();
  }

  /** Play on after a pause from outside the world (the visitor's ▶). */
  resume() {
    if (this.playing && this.film.paused && !this.film.ended) void playWithSound(this.film);
  }

  /** A film is running (not a close look held on its last frame). */
  get playingFilm() {
    return this.playing !== null;
  }

  /**
   * Change the picture while a film plays: the lighter file takes over at the
   * same moment, without pausing at zero, which is what a visitor on a slow
   * connection is offered.
   */
  switchQuality(quality: Quality) {
    this.quality = quality;
    if (!this.playing) return;
    const src = localOrRemote(pick(this.playing, quality));
    if (this.film.getAttribute('src') === src) return;
    const at = this.film.currentTime, wasPlaying = !this.film.paused && !this.film.ended;
    this.film.src = src;
    if (at > 0) this.film.currentTime = at;
    if (wasPlaying) void playWithSound(this.film);
    this.follow(this.film);
  }

  setSound(volume: number, muted: boolean) {
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume() {
    for (const video of this.films) {
      video.volume = this.volume;
      video.muted = this.muted; // only true when the visitor turned sound off
    }
    this.deck.setVolume(this.volume, this.muted);
  }

  private setStill(place: { still: string }) {
    if (this.still.getAttribute('src') !== place.still) this.still.src = place.still;
    if (this.backdropStill.getAttribute('src') !== place.still) this.backdropStill.src = place.still;
  }

  private hideFilm() {
    for (const video of this.films) {
      video.classList.remove('on');
      video.pause();
    }
  }

  /** The backdrop plays whatever the frame plays, a little behind it at most. */
  private follow(video: HTMLVideoElement | null) {
    this.following = video;
    if (!video) {
      this.backdropVideo.pause();
      this.backdropVideo.classList.remove('on');
      return;
    }
    // The attribute, not currentSrc: right after a switch to 720p currentSrc still names the 2K file.
    const src = video.getAttribute('src') || video.currentSrc || '';
    // Loops repeat in the backdrop on their own; films play once.
    this.backdropVideo.loop = video !== this.film;
    setSource(this.backdropVideo, src);
    this.backdropVideo.currentTime = video.currentTime;
    void this.backdropVideo.play().then(() => this.backdropVideo.classList.add('on'), () => undefined);
  }

  private sync() {
    const video = this.following;
    if (!video || this.backdropVideo.readyState < 2) return;
    if (Math.abs(this.backdropVideo.currentTime - video.currentTime) > 0.25) this.backdropVideo.currentTime = video.currentTime;
    if (video.paused !== this.backdropVideo.paused) void (video.paused ? this.backdropVideo.pause() : this.backdropVideo.play().catch(() => undefined));
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
