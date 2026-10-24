// A crossing that leaves through a small part of its picture (a district on a
// map, a window across the street, a screen) starts with a digital push-in:
// the camera moves from the whole still onto a crop centred on that part, frame
// for frame, and the rendered film starts from the crop. A model told "dive into
// the upper left" goes wherever it likes (measured on a city map: the dives
// missed their districts by 5% to 44% of the map); a film pinned to start on
// the crop can only start there. `render` sends the crop as the film's first
// picture; `build` puts the push-in in front of the film, so the finished film
// still opens on the place's own still.
import sharp from 'sharp';

export const PUSH_IN = Object.freeze({ minZoom: 1.25, maxZoom: 3, frames: 18, minFrames: 6, maxFrames: 48 });

/** The crop (in the still's pixels, fractional) that a push-in lands on: 1/zoom of the picture, centred on `at`, kept inside it. */
export function pushInRegion(width, height, { at, zoom }) {
  const w = width / zoom, h = height / zoom;
  const left = Math.min(width - w, Math.max(0, at[0] * width - w / 2));
  const top = Math.min(height - h, Math.max(0, at[1] * height - h / 2));
  return { left, top, width: w, height: h };
}

/**
 * The view `k` frames into an `n`-frame push-in: a zoom about the one fixed
 * point that carries the whole picture onto the crop, eased in (the scale grows
 * as zoom^(u^1.6)). Frame 0 is the whole still; frame n would be the crop.
 */
export function pushInView(width, height, region, k, n) {
  const zoom = width / region.width;
  const s = zoom ** ((k / n) ** 1.6);
  const fixed = { x: region.left / (1 - 1 / zoom), y: region.top / (1 - 1 / zoom) };
  return { left: fixed.x - fixed.x / s, top: fixed.y - fixed.y / s, width: width / s, height: height / s };
}

/** Sample `view` of an RGB picture into a width × height RGB buffer (bilinear, centre-aligned). */
export function renderView(rgb, srcWidth, srcHeight, view, width, height) {
  const out = Buffer.alloc(width * height * 3);
  const sx = view.width / width, sy = view.height / height;
  const xs = new Float64Array(width), ys = new Float64Array(height);
  for (let x = 0; x < width; x++) xs[x] = Math.min(srcWidth - 1.001, Math.max(0, view.left + (x + 0.5) * sx - 0.5));
  for (let y = 0; y < height; y++) ys[y] = Math.min(srcHeight - 1.001, Math.max(0, view.top + (y + 0.5) * sy - 0.5));
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(ys[y]), fy = ys[y] - y0, row0 = y0 * srcWidth, row1 = (y0 + 1) * srcWidth;
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(xs[x]), fx = xs[x] - x0;
      const a = (row0 + x0) * 3, b = a + 3, c = (row1 + x0) * 3, d = c + 3, o = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = rgb[a + ch] + (rgb[b + ch] - rgb[a + ch]) * fx;
        const bottom = rgb[c + ch] + (rgb[d + ch] - rgb[c + ch]) * fx;
        out[o + ch] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}

const rgbOf = async path => {
  const { data, info } = await sharp(path).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
};

/** The crop a push-in lands on, at `size`, as a JPEG: the first picture the film is rendered from. */
export async function pushInStart(stillPath, pushIn, size) {
  const { rgb, width, height } = await rgbOf(stillPath);
  const view = pushInRegion(width, height, pushIn);
  return sharp(renderView(rgb, width, height, view, size.width, size.height), { raw: { width: size.width, height: size.height, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Each frame of the push-in at `size`, as PNGs written by `write(index, bytes)`. Returns the frame count. */
export async function pushInFrames(stillPath, pushIn, size, write) {
  const { rgb, width, height } = await rgbOf(stillPath);
  const region = pushInRegion(width, height, pushIn);
  const n = pushIn.frames ?? PUSH_IN.frames;
  for (let k = 0; k < n; k++) {
    const view = pushInView(width, height, region, k, n);
    await write(k, await sharp(renderView(rgb, width, height, view, size.width, size.height), { raw: { width: size.width, height: size.height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer());
  }
  return n;
}

/** What is wrong with a film's `pushIn`, as messages (none when it is fine). */
export function pushInIssues(pushIn, kind) {
  const issues = [];
  if (typeof pushIn !== 'object' || Array.isArray(pushIn) || pushIn === null) return ['pushIn is { at: [x, y], zoom, frames }'];
  if (kind !== 'crossing') issues.push('only a crossing starts with a push-in (it leaves through that part of the picture)');
  for (const key of Object.keys(pushIn)) if (!['at', 'zoom', 'frames'].includes(key)) issues.push(`unknown field "${key}" (at, zoom, frames)`);
  const inUnit = v => typeof v === 'number' && v >= 0 && v <= 1;
  if (!Array.isArray(pushIn.at) || pushIn.at.length !== 2 || !pushIn.at.every(inUnit)) issues.push('`at` is [x, y]: the centre of the part the film leaves through, as fractions of the picture');
  if (!(typeof pushIn.zoom === 'number' && pushIn.zoom >= PUSH_IN.minZoom && pushIn.zoom <= PUSH_IN.maxZoom)) issues.push(`\`zoom\` is a number from ${PUSH_IN.minZoom} to ${PUSH_IN.maxZoom} (2 lands on a crop half the picture's width)`);
  if (pushIn.frames !== undefined && !(Number.isInteger(pushIn.frames) && pushIn.frames >= PUSH_IN.minFrames && pushIn.frames <= PUSH_IN.maxFrames)) issues.push(`\`frames\` is a whole number from ${PUSH_IN.minFrames} to ${PUSH_IN.maxFrames} (default ${PUSH_IN.frames}: three quarters of a second)`);
  return issues;
}
