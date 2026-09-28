// The picture: one place shown whole at the world's shape, a blurred copy of
// the same moving picture filling the screen behind it, and the films that
// carry you between places.
//
// Layers inside the frame, bottom to top: the still (a fallback and the poster),
// the two loop elements, the film. A place is shown with video frames whenever
// it has a loop, because a JPEG and a video decode to slightly different colours
// and the films start and end on video frames.
import { LoopDeck } from './loop-deck';
import { playWithSound, setSource, whenEnded, whenPainted } from './media';
import { pick, type Film, type Place, type Quality, type World } from './world';

export class Stage {
  readonly frame: HTMLElement;
  readonly overlay: HTMLElement;
  private readonly still: HTMLImageElement;
  private readonly deck: LoopDeck;
  private readonly film: HTMLVideoElement;
  private readonly backdropVideo: HTMLVideoElement;
  private readonly backdropStill: HTMLImageElement;
  private following: HTMLVideoElement | null = null;
  private volume = 1;
  private muted = false;
  quality: Quality = '2k';

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
    this.still = el('img', 'layer still') as HTMLImageElement;
    this.still.alt = '';
    this.frame.append(this.still);
    this.deck = new LoopDeck(this.frame);
    this.deck.onShow = video => this.follow(video);
    this.film = el('video', 'layer film') as HTMLVideoElement;
    this.film.playsInline = true;
    this.film.preload = 'auto';
    this.frame.append(this.film);
    this.overlay = el('div', 'overlay');
    this.frame.append(this.overlay);

    root.append(backdrop, this.frame);
    setInterval(() => this.sync(), 500);
  }

  /** Show a place at once: its still, then its living loop from the first frame. */
  async show(place: Place) {
    this.setStill(place);
    this.hideFilm();
    if (place.loop) await this.deck.start(pick(place.loop, this.quality));
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
    const src = pick(film, this.quality);
    setSource(this.film, src);
    this.film.currentTime = 0;
    this.applyVolume();
    void playWithSound(this.film);
    await whenPainted(this.film);
    this.film.classList.add('on');
    this.deck.stop();
    this.follow(this.film);
    // Get the landing ready while the film plays.
    const loopSrc = landing.loop ? pick(landing.loop, this.quality) : null;
    if (loopSrc) this.deck.load(loopSrc);
    await whenEnded(this.film);
    this.setStill(landing);
    if (loopSrc) await this.deck.start(loopSrc);
    else this.follow(null);
    this.hideFilm();
  }

  /** Jump to the end of the film that is playing (its last frame is the landing). */
  skip() {
    if (this.film.classList.contains('on') && Number.isFinite(this.film.duration)) {
      this.film.currentTime = Math.max(0, this.film.duration - 0.05);
    }
  }

  get playingFilm() {
    return this.film.classList.contains('on');
  }

  /** Buffer a film while nothing is playing, so the next stop starts at once. */
  preload(film: Film | undefined) {
    if (!film || this.playingFilm) return;
    setSource(this.film, pick(film, this.quality));
  }

  setSound(volume: number, muted: boolean) {
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume() {
    this.film.volume = this.volume;
    this.film.muted = this.muted; // only true when the visitor turned sound off
    this.deck.setVolume(this.volume, this.muted);
  }

  private setStill(place: Place) {
    if (this.still.getAttribute('src') !== place.still) this.still.src = place.still;
    if (this.backdropStill.getAttribute('src') !== place.still) this.backdropStill.src = place.still;
  }

  private hideFilm() {
    this.film.classList.remove('on');
    this.film.pause();
  }

  /** The backdrop plays whatever the frame plays, a little behind it at most. */
  private follow(video: HTMLVideoElement | null) {
    this.following = video;
    if (!video) {
      this.backdropVideo.pause();
      this.backdropVideo.classList.remove('on');
      return;
    }
    const src = video.currentSrc || video.getAttribute('src') || '';
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
