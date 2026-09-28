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
