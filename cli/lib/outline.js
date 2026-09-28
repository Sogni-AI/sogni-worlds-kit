// Turn a SAM 3 mask into the outline a visitor sees and clicks: keep the
// object (drop specks smaller than a fraction of its largest piece), fill
// pinholes, trace the pixel boundary, and simplify it to within ~1.5 px.
// The result is an SVG path in the mask's own pixel coordinates.
import sharp from 'sharp';

/** Read a mask image into a width × height array of 0/1. */
export async function readMask(bytes) {
  const { data, info } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) pixels[i] = data[i * channels] >= 128 ? 1 : 0;
  return { pixels, width, height };
}

/** 4-connected components of pixels equal to `value`: an id per pixel, area per id, and whether it touches the border. */
function components(pixels, width, height, value) {
  const ids = new Int32Array(width * height).fill(-1);
  const areas = [];
  const border = [];
  const stack = [];
  for (let start = 0; start < pixels.length; start += 1) {
    if (pixels[start] !== value || ids[start] !== -1) continue;
    const id = areas.length;
    let area = 0;
    let touches = false;
    ids[start] = id;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop();
      area += 1;
      const x = index % width;
      const y = (index - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touches = true;
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const next of neighbours) {
        if (next >= 0 && pixels[next] === value && ids[next] === -1) {
          ids[next] = id;
          stack.push(next);
        }
      }
    }
    areas.push(area);
    border.push(touches);
  }
  return { ids, areas, border };
}

/** Drop islands under keepRatio of the largest piece; fill holes under holeRatio of the object. */
export function tidyMask({ pixels, width, height }, { keepRatio = 0.12, holeRatio = 0.02 } = {}) {
  const out = Uint8Array.from(pixels);
  const fg = components(out, width, height, 1);
  const largest = Math.max(0, ...fg.areas);
  let islandsDropped = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] && fg.areas[fg.ids[i]] < largest * keepRatio) out[i] = 0;
  }
  fg.areas.forEach(area => { if (area < largest * keepRatio) islandsDropped += 1; });
  const on = out.reduce((sum, value) => sum + value, 0);
  const bg = components(out, width, height, 0);
  let holesFilled = 0;
  for (let i = 0; i < out.length; i += 1) {
    const id = bg.ids[i];
    if (!out[i] && !bg.border[id] && bg.areas[id] < on * holeRatio) out[i] = 1;
  }
  bg.areas.forEach((area, id) => { if (!bg.border[id] && area < on * holeRatio) holesFilled += 1; });
  return { pixels: out, width, height, cleanup: { keepRatio, holeRatio, islandsDropped, holesFilled } };
}

/**
 * Closed rings along pixel edges, foreground on the right when walking
 * (clockwise on screen for an outer edge). At a corner shared by two diagonal
 * pixels the walk turns right, so diagonal neighbours stay separate pieces.
 */
export function traceRings({ pixels, width, height }) {
  const fg = (x, y) => x >= 0 && y >= 0 && x < width && y < height && pixels[y * width + x] === 1;
  const W = width + 1;
  const outgoing = new Map(); // vertex -> list of [toVertex, dx, dy]
  const add = (x0, y0, x1, y1) => {
    const from = y0 * W + x0;
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push([y1 * W + x1, x1 - x0, y1 - y0]);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!fg(x, y)) continue;
      if (!fg(x, y - 1)) add(x, y, x + 1, y);
      if (!fg(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!fg(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!fg(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const rings = [];
  const take = (vertex, dx, dy) => {
    const options = outgoing.get(vertex);
    if (!options?.length) return null;
    let pick = 0;
    if (options.length > 1) {
      // Right turn first (screen coordinates, y down), then straight, then left.
      const rank = ([, ndx, ndy]) => {
        const cross = dx * ndy - dy * ndx;
        return cross > 0 ? 0 : cross === 0 ? 1 : 2;
      };
      options.forEach((option, index) => { if (rank(option) < rank(options[pick])) pick = index; });
    }
    const [chosen] = options.splice(pick, 1);
    if (!options.length) outgoing.delete(vertex);
    return chosen;
  };
  while (outgoing.size) {
    const [start] = outgoing.keys();
    const ring = [];
    let vertex = start;
    let dx = 0;
    let dy = 0;
    for (;;) {
      const step = take(vertex, dx, dy);
      if (!step) break;
      ring.push([vertex % W, Math.floor(vertex / W)]);
      [vertex, dx, dy] = step;
      if (vertex === start) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

const area = ring => ring.reduce((sum, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return sum + x * ny - nx * y;
}, 0) / 2;

function perpendicular([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!length) return Math.hypot(px - ax, py - ay);
  return Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
}

function rdp(points, tolerance) {
  if (points.length < 3) return points;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicular(points[i], points[0], points.at(-1));
    if (d > max) { max = d; index = i; }
  }
  if (max <= tolerance) return [points[0], points.at(-1)];
  return [...rdp(points.slice(0, index + 1), tolerance).slice(0, -1), ...rdp(points.slice(index), tolerance)];
}

/** Simplify a closed ring: split it at its two farthest-apart points and simplify each half. */
export function simplifyRing(ring, tolerance = 1.5) {
  if (ring.length < 8) return ring;
  let far = 0;
  let best = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > best) { best = d; far = i; }
  }
  const first = rdp(ring.slice(0, far + 1), tolerance);
  const second = rdp([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/**
 * The outline of a mask: { width, height, path, coverage, cleanup, vertices }.
 * Rings smaller than `minArea` square pixels are dropped. Draw it with
 * fill-rule evenodd so any hole stays a hole.
 */
export function maskOutline(mask, { keepRatio, holeRatio, tolerance = 1.5, minArea = 16 } = {}) {
  const tidy = tidyMask(mask, { keepRatio, holeRatio });
  const on = tidy.pixels.reduce((sum, value) => sum + value, 0);
  const rings = traceRings(tidy).filter(ring => Math.abs(area(ring)) >= minArea);
  const traced = rings.reduce((sum, ring) => sum + ring.length, 0);
  const simple = rings.map(ring => simplifyRing(ring, tolerance)).filter(ring => ring.length >= 3);
  const path = simple.map(ring => `M${ring.map(([x, y]) => `${x} ${y}`).join('L')}Z`).join('');
  return {
    width: mask.width,
    height: mask.height,
    path,
    coverage: on / (mask.width * mask.height),
    rawCoverage: mask.pixels.reduce((sum, value) => sum + value, 0) / (mask.width * mask.height),
    cleanup: { ...tidy.cleanup, simplifyPx: tolerance, tracedVertices: traced, keptVertices: simple.reduce((s, r) => s + r.length, 0), rings: simple.length },
  };
}
