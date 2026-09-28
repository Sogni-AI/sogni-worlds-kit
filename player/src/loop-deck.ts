// The living photograph. A loop film starts and ends on the place's still, so
// two <video> elements take turns: just before one ends, the other starts from
// its first frame and takes over once that frame is on screen. It is a straight
// frame handoff (the frames are the same picture), never a crossfade.
import { playWithSound, setSource, whenPainted } from './media';

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Start the next lap this many seconds before the current one ends. */
const LEAD = 2 / 24;

export class LoopDeck {
  readonly videos: [FrameVideo, FrameVideo];
  private current = 0;
  private running = false;
  private swapping = false;
  private src = '';
  /** Told whenever a different element becomes the visible one. */
  onShow?: (video: HTMLVideoElement) => void;

  constructor(parent: HTMLElement) {
    const make = () => {
      const video = document.createElement('video') as FrameVideo;
      video.className = 'layer loop';
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('timeupdate', () => this.check());
      video.addEventListener('ended', () => this.check(true));
      parent.append(video);
      return video;
    };
    this.videos = [make(), make()];
  }

  get visible(): HTMLVideoElement | null {
    return this.running ? this.videos[this.current] : null;
  }

  /** Point both elements at a loop, paused on its first frame, hidden. */
  load(src: string) {
    this.src = src;
    for (const video of this.videos) {
      setSource(video, src);
      if (!this.running) video.currentTime = 0;
    }
  }

  /** Start from the first frame; resolves once that frame is on screen. */
  async start(src: string) {
    this.stop();
    this.load(src);
    this.running = true;
    const video = this.videos[this.current];
    video.currentTime = 0;
    void playWithSound(video);
    await whenPainted(video);
    if (!this.running || this.src !== src) return;
    this.show(this.current);
  }

  stop() {
    this.running = false;
    this.swapping = false;
    for (const video of this.videos) {
      video.pause();
      video.classList.remove('on');
    }
  }

  setVolume(volume: number, muted: boolean) {
    for (const video of this.videos) {
      video.volume = volume;
      video.muted = muted; // only ever true because the visitor turned sound off
    }
  }

  private show(index: number) {
    const previous = this.videos[1 - index];
    this.videos[index].classList.add('on');
    previous.classList.remove('on');
    previous.pause();
    previous.currentTime = 0;
    this.current = index;
    this.swapping = false;
    this.onShow?.(this.videos[index]);
    this.watch(this.videos[index]);
  }

  /** Check every presented frame (timeupdate alone fires only ~4 times a second). */
  private watch(video: FrameVideo) {
    if (!video.requestVideoFrameCallback) return;
    const tick = () => {
      if (!this.running || this.videos[this.current] !== video || this.swapping) return;
      this.check();
      video.requestVideoFrameCallback!(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  private check(ended = false) {
    const video = this.videos[this.current];
    if (!this.running || this.swapping || !Number.isFinite(video.duration)) return;
    if (!ended && video.duration - video.currentTime > LEAD) return;
    this.swapping = true;
    const next = 1 - this.current;
    const standby = this.videos[next];
    standby.currentTime = 0;
    void playWithSound(standby);
    void whenPainted(standby, 3000).then(() => {
      if (this.running) this.show(next);
    });
  }
}
