// Where things are in a picture: an outline's area and box, and where its
// label goes. Pure arithmetic on the traced SVG paths, so it can be tested
// without a browser (test/geometry.test.js).
import type { Hotspot, Outline } from './world';

/** Outlines covering less of the picture than this get the finger-sized margin. */
export const SMALL_OUTLINE = 0.004;
/** An object smaller than this share of the frame's width and height keeps its label beside it, never on it. */
const LABEL_BESIDE = 0.4;

/** How much of its picture an outline covers (the rings' areas; holes are not taken off). */
export function outlineCoverage(outline: Outline) {
  let area = 0;
  for (const ring of outline.path.split('M')) {
    const n = (ring.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const points = Math.floor(n.length / 2);
    let twice = 0;
    for (let k = 0; k < points; k++) {
      const m = (k + 1) % points;
      twice += n[2 * k] * n[2 * m + 1] - n[2 * m] * n[2 * k + 1];
    }
    area += Math.abs(twice) / 2;
  }
  return area / (outline.width * outline.height);
}

/** The outline's bounding box as shares of the picture: [left, top, right, bottom]. */
export function outlineBox(outline: Outline): [number, number, number, number] {
  const n = (outline.path.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let k = 0; k + 1 < n.length; k += 2) {
    left = Math.min(left, n[k]); right = Math.max(right, n[k]);
    top = Math.min(top, n[k + 1]); bottom = Math.max(bottom, n[k + 1]);
  }
  return [left / outline.width, top / outline.height, right / outline.width, bottom / outline.height];
}

/**
 * Where a label goes. A label written on top of a small object hides the very
 * thing it names, so it moves just above the object (or below it, when the
 * object sits near the top of the picture). A label placed off the object,
 * or on one too big to hide, stays where the plan put it.
 */
export function labelPlacement(spot: Pick<Hotspot, 'at' | 'outline'>): { x: number; y: number; anchor: 'centre' | 'above' | 'below' } {
  const [x, y] = spot.at;
  if (!spot.outline) return { x, y, anchor: 'centre' };
  const [left, top, right, bottom] = outlineBox(spot.outline);
  const inside = x >= left && x <= right && y >= top && y <= bottom;
  if (!inside || right - left > LABEL_BESIDE || bottom - top > LABEL_BESIDE) return { x, y, anchor: 'centre' };
  const centre = Math.min(0.92, Math.max(0.08, (left + right) / 2));
  return top > 0.16 ? { x: centre, y: top, anchor: 'above' } : { x: centre, y: bottom, anchor: 'below' };
}
