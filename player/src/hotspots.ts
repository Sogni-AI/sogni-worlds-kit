// The things to click. Each object's traced SAM 3 outline is an SVG path drawn
// in its own width × height space that covers the whole picture, so it scales
// with the frame. Outlines light up on hover (or tap); labels show on arrival,
// then on hover, and again whenever the visitor taps the picture. The label is
// a button too, clickable even while it is faded out, and a small outline gets
// an invisible finger-sized margin so it is as easy to hit as a big one.
import { el } from './stage';
import type { Hotspot, Outline, Place, World } from './world';

const SVG = 'http://www.w3.org/2000/svg';
const LABELS_ON_ARRIVAL_MS = 6000;
/** Outlines covering less of the picture than this get the finger-sized margin. */
export const SMALL_OUTLINE = 0.004;

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

export class Hotspots {
  private readonly layer: HTMLElement;
  private labelTimer?: ReturnType<typeof setTimeout>;

  constructor(overlay: HTMLElement, private readonly world: World, private readonly onGo: (spot: Hotspot) => void) {
    this.layer = el('div', 'hotspots');
    overlay.append(this.layer);
    // Tapping the picture itself (not an object) brings the labels back.
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target === this.layer) this.showLabels();
    });
    window.addEventListener('resize', () => this.keepClear());
  }

  /**
   * An object near the top or bottom of the picture would put its label under
   * the place's title or the bottom buttons; move such a label just clear of
   * them, staying as close to its object as it can.
   */
  private keepClear() {
    const top = document.querySelector('.bar.top')?.getBoundingClientRect().bottom ?? 0;
    const bottom = document.querySelector('.bar.bottom')?.getBoundingClientRect().top ?? innerHeight;
    for (const label of this.layer.querySelectorAll<HTMLElement>('.label')) {
      label.style.marginTop = '';
      const box = label.getBoundingClientRect();
      if (box.top < top + 6) label.style.marginTop = `${top + 6 - box.top}px`;
      else if (box.bottom > bottom - 6) label.style.marginTop = `${bottom - 6 - box.bottom}px`;
    }
  }

  render(place: Place) {
    this.layer.replaceChildren();
    for (const spot of place.hotspots) {
      const group = el('div', 'hotspot');
      const light = (on: boolean) => group.classList.toggle('lit', on);

      const clickable = (target: Element) => {
        target.addEventListener('pointerenter', () => light(true));
        target.addEventListener('pointerleave', () => light(false));
        target.addEventListener('click', event => {
          event.stopPropagation();
          this.onGo(spot);
        });
      };

      if (spot.outline) {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', `0 0 ${spot.outline.width} ${spot.outline.height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('outline');
        const traced = (className?: string) => {
          const path = document.createElementNS(SVG, 'path');
          path.setAttribute('d', spot.outline!.path);
          path.setAttribute('fill-rule', 'evenodd');
          if (className) path.classList.add(className);
          clickable(path);
          svg.append(path);
        };
        // A wide invisible stroke under a small outline: 22 px of margin all round.
        if (outlineCoverage(spot.outline) < SMALL_OUTLINE) traced('hit');
        traced();
        group.append(svg);
      }

      const label = el('button', 'label');
      label.type = 'button';
      label.style.left = `${spot.at[0] * 100}%`;
      label.style.top = `${spot.at[1] * 100}%`;
      label.append(el('span', 'eyebrow', this.eyebrow(spot)), el('span', 'action', spot.label));
      if (spot.hint) label.append(el('span', 'hint', spot.hint));
      clickable(label);
      label.addEventListener('focus', () => light(true));
      label.addEventListener('blur', () => light(false));
      if (spot.next) group.classList.add('next');
      if (spot.shortcut) group.classList.add('shortcut');
      group.append(label);
      this.layer.append(group);
    }
    this.layer.hidden = false;
    requestAnimationFrame(() => this.keepClear());
    this.showLabels(LABELS_ON_ARRIVAL_MS);
  }

  hide() {
    clearTimeout(this.labelTimer);
    this.layer.hidden = true;
    this.layer.classList.remove('labels-on');
  }

  showLabels(ms = 4000) {
    clearTimeout(this.labelTimer);
    this.layer.classList.add('labels-on');
    this.labelTimer = setTimeout(() => this.layer.classList.remove('labels-on'), ms);
  }

  private eyebrow(spot: Hotspot) {
    if (!spot.to) return 'Moment';
    const title = this.world.places.find(place => place.id === spot.to)?.title ?? spot.to;
    if (spot.next) return `Next stop · ${title}`;
    if (spot.shortcut) return `Shortcut to ${title}`;
    return `To ${title}`;
  }
}
