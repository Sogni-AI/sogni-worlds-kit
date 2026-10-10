// Small helpers for driving <video> precisely.

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

/**
 * Resolve once the video has put a frame on screen at its current position,
 * or after `timeoutMs` so a slow network never freezes the world.
 */
export function whenPainted(video: HTMLVideoElement, timeoutMs = 6000): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('playing', onPlaying);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onPlaying = () => ((video as FrameVideo).requestVideoFrameCallback ? undefined : finish());
    video.addEventListener('playing', onPlaying);
    (video as FrameVideo).requestVideoFrameCallback?.(finish);
  });
}

/**
 * Resolve when the video reaches its last frame (it stays on screen, paused
 * there), or fails to load, so a broken file never strands the visitor.
 */
export function whenEnded(video: HTMLVideoElement): Promise<void> {
  return new Promise(resolve => {
    if (video.ended) return resolve();
    const done = () => {
      video.removeEventListener('ended', done);
      video.removeEventListener('error', done);
      resolve();
    };
    video.addEventListener('ended', done);
    video.addEventListener('error', done);
  });
}

/**
 * Play with sound. Browsers refuse audible autoplay until the visitor has
 * interacted with the page; the Begin tap is that interaction. If a browser
 * still refuses, the video stays paused and the next tap plays it.
 */
export async function playWithSound(video: HTMLVideoElement): Promise<boolean> {
  try {
    await video.play();
    return true;
  } catch {
    return false;
  }
}

export function setSource(video: HTMLVideoElement, src: string) {
  if (video.getAttribute('src') !== src) video.src = src;
}

/**
 * How much of a clip the browser has fetched, 0–1, or null before its length
 * is known. A film streams from the start, so the furthest buffered point is
 * what a visitor is waiting on.
 */
export function bufferedFraction(video: HTMLVideoElement): number | null {
  const { buffered, duration } = video;
  if (!Number.isFinite(duration) || duration <= 0 || !buffered.length) return null;
  let end = 0;
  for (let i = 0; i < buffered.length; i += 1) end = Math.max(end, buffered.end(i));
  return Math.min(1, end / duration);
}

/**
 * Tell the owner when a clip that should be playing is starved of bytes: it
 * has not started after `afterMs`, or its time has stopped advancing for that
 * long while it is meant to be playing (paused time does not count). A slow
 * connection must never skip a film, so a stall is reported for the page to
 * say so and offer the lighter picture, and the film is left to play through.
 */
export function watchStall(video: HTMLVideoElement, onChange: (stalled: boolean) => void, afterMs = 8000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined, stalled = false, last = video.currentTime;
  const report = (value: boolean) => { if (stalled !== value) { stalled = value; onChange(value); } };
  const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const arm = () => { clear(); timer = setTimeout(() => { if (video.paused || video.ended) arm(); else report(true); }, afterMs); };
  const advanced = () => { if (video.currentTime !== last) { last = video.currentTime; report(false); } arm(); };
  const names = ['timeupdate', 'playing', 'waiting', 'stalled', 'seeking', 'play'];
  for (const name of names) video.addEventListener(name, advanced);
  arm();
  return () => { clear(); for (const name of names) video.removeEventListener(name, advanced); };
}
