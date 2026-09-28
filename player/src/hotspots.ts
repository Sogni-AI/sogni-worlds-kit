// The things to click. Each object's traced SAM 3 outline is an SVG path drawn
// in its own width × height space that covers the whole picture, so it scales
// with the frame. Outlines light up on hover (or tap); labels show on arrival,
// then on hover, and again whenever the visitor taps the picture.
import { el } from './stage';
import type { Hotspot, Place, World } from './world';

const SVG = 'http://www.w3.org/2000/svg';
const LABELS_ON_ARRIVAL_MS = 6000;

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
  }

  render(place: Place) {
    this.layer.replaceChildren();
    for (const spot of place.hotspots) {
      const group = el('div', 'hotspot');
      const light = (on: boolean) => group.classList.toggle('lit', on);

      if (spot.outline) {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('viewBox', `0 0 ${spot.outline.width} ${spot.outline.height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('outline');
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', spot.outline.path);
        path.setAttribute('fill-rule', 'evenodd');
        path.addEventListener('pointerenter', () => light(true));
        path.addEventListener('pointerleave', () => light(false));
        path.addEventListener('click', event => {
          event.stopPropagation();
          this.onGo(spot);
        });
        svg.append(path);
        group.append(svg);
      }

      const label = el('button', 'label');
      label.type = 'button';
      label.style.left = `${spot.at[0] * 100}%`;
      label.style.top = `${spot.at[1] * 100}%`;
      label.append(el('span', 'eyebrow', this.eyebrow(spot)), el('span', 'action', spot.label));
      if (spot.hint) label.append(el('span', 'hint', spot.hint));
      label.addEventListener('pointerenter', () => light(true));
      label.addEventListener('pointerleave', () => light(false));
      label.addEventListener('focus', () => light(true));
      label.addEventListener('blur', () => light(false));
      label.addEventListener('click', event => {
        event.stopPropagation();
        this.onGo(spot);
      });
      if (spot.next) group.classList.add('next');
      if (spot.shortcut) group.classList.add('shortcut');
      group.append(label);
      this.layer.append(group);
    }
    this.layer.hidden = false;
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
