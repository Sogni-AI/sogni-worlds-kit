// Photographs → canonical stills. A canonical still is made once and never
// touched again: every film that starts or ends at a place is pinned to its
// exact pixels, and every clickable outline is traced on it.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { delivered } from './h3.js';

export const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.avif'];

/** A place id from a file name: "IMG 0012 (edited).JPG" → "img-0012-edited". */
/** A place id from a photo's filename. A leading "01-" only orders the photos, so it is dropped. */
export const slug = name => basename(name, extname(name)).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/^\d{1,3}[-_. ]+(?=[a-z])/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'place';

/**
 * The bytes sharp can read. HEIC needs converting first: sharp's prebuilt
 * binaries cannot decode it, macOS `sips` can. Elsewhere, export JPEGs.
 */
export function readablePhoto(path, cacheDir) {
  const extension = extname(path).toLowerCase();
  if (extension !== '.heic' && extension !== '.heif') return readFileSync(path);
  const converted = join(cacheDir, 'heic', `${slug(path)}.jpg`);
  if (!existsSync(converted)) {
    mkdirSync(join(cacheDir, 'heic'), { recursive: true });
    const result = spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', path, '--out', converted], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`${basename(path)} is HEIC, which needs converting: export it as a full-size JPEG (on a Mac, sips does this automatically)`);
  }
  return readFileSync(converted);
}

/** The camera's own record of how the photo was taken, when the file carries it. */
export function exposureOf(metadata) {
  if (!metadata.exif) return null;
  try {
    const exif = exifReader(metadata.exif);
    const photo = exif.Photo ?? exif.exif ?? {};
    const image = exif.Image ?? exif.image ?? {};
    const fraction = seconds => (seconds >= 1 || !seconds ? `${seconds}s` : `1/${Math.round(1 / seconds)}s`);
    const record = {
      camera: [image.Make, image.Model].filter(Boolean).join(' ').trim() || undefined,
      lens: photo.LensModel || undefined,
      focalLength: photo.FocalLength ? `${Math.round(photo.FocalLength)}mm` : undefined,
      aperture: photo.FNumber ? `f/${Number(photo.FNumber).toFixed(1).replace(/\.0$/, '')}` : undefined,
      shutter: photo.ExposureTime ? fraction(photo.ExposureTime) : undefined,
      iso: photo.ISOSpeedRatings ?? photo.PhotographicSensitivity ?? undefined,
      taken: photo.DateTimeOriginal instanceof Date ? photo.DateTimeOriginal.toISOString() : undefined,
    };
    return Object.values(record).some(Boolean) ? JSON.parse(JSON.stringify(record)) : null;
  } catch {
    return null;
  }
}

/** Upright size of a photo (EXIF orientation 5–8 swaps width and height). */
export async function uprightSize(bytes) {
  const metadata = await sharp(bytes).metadata();
  const swap = metadata.orientation >= 5;
  return { width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height, metadata };
}

/**
 * The centred crop of a width × height photo to the canvas's exact shape, and
 * the size the still is written at: the delivered film size when the photo is
 * big enough, otherwise the largest exact-shape size it holds (never enlarged).
 */
export function planStill(width, height, canvas) {
  const target = delivered(canvas);
  // The largest region of exactly the canvas's shape: a whole multiple of its reduced ratio, centred.
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(canvas.width, canvas.height);
  const [rw, rh] = [canvas.width / g, canvas.height / g];
  const k = Math.floor(Math.min(width / rw, height / rh));
  const crop = { width: k * rw, height: k * rh };
  crop.left = Math.floor((width - crop.width) / 2);
  crop.top = Math.floor((height - crop.height) / 2);
  const removed = 1 - (crop.width * crop.height) / (width * height);
  // Downscale to the delivered size; a smaller photo keeps its own pixels (never enlarged).
  const size = crop.width > target.width ? { ...target } : { width: crop.width, height: crop.height };
  return { crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height }, removed, size, small: crop.height < canvas.height };
}

/** Write one canonical still: upright, sRGB, exact crop, Lanczos, JPEG q95 4:4:4. */
export async function writeStill(bytes, plan, output) {
  const image = sharp(bytes, { failOn: 'error' })
    .rotate()
    .extract(plan.crop)
    .resize(plan.size.width, plan.size.height, { kernel: 'lanczos3', fit: 'fill' })
    .toColourspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: false });
  await image.toFile(output);
}

/** A copy no wider than 1024 px, for vision models that cap image size. */
export async function writePreview(stillPath, output, longEdge = 1024) {
  await sharp(stillPath).resize(longEdge, longEdge, { fit: 'inside', kernel: 'lanczos3' }).jpeg({ quality: 88 }).toFile(output);
}
