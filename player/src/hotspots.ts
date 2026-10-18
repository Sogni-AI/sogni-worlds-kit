// The things to click. Each object's traced SAM 3 outline is an SVG path drawn
// in its own width × height space that covers the whole picture, so it scales
// with the frame. Outlines light up on hover (or tap). Every label shows on
// arrival and stays (the live worlds' rule): a click or tap on the open picture
// hides them all, and another brings them back. The label is a button too, and
// a small outline gets an invisible finger-sized margin so it is as easy to hit
// as a big one.
import { labelPlacement, outlineCoverage, SMALL_OUTLINE } from './geometry';
import { el } from './stage';
import type { Hotspot, Place, World } from './world';

const SVG = 'http://www.w3.org/2000/svg';

export class Hotspots {
  private readonly layer: HTMLElement;
  /** The visitor hid the labels in this place by clicking the open picture. */
  private labelsHidden = false;

  constructor(
    overlay: HTMLElement,
    private readonly world: World,
    private readonly onGo: (spot: Hotspot) => void,
    private readonly collected: (spot: Hotspot) => boolean = () => false,
    private readonly played: (spot: Hotspot) => boolean = () => false,
  ) {
    this.layer = el('div', 'hotspots');
    overlay.append(this.layer);
    // Clicking the picture itself (not an object) hides the labels; another click brings them back.
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target === this.layer) this.setLabels(this.labelsHidden);
    });
    window.addEventListener('resize', () => this.keepClear());
  }

  /**
   * Keep every label readable: clear of the place's title and the bottom
   * buttons, inside the picture's sides, and off the other labels, staying as
   * close to its object as it can.
   */
  private keepClear() {
    const top = document.querySelector('.bar.top')?.getBoundingClientRect().bottom ?? 0;
    const bottom = document.querySelector('.bar.bottom')?.getBoundingClientRect().top ?? innerHeight;
    const frame = this.layer.getBoundingClientRect();
    const labels = [...this.layer.querySelectorAll<HTMLElement>('.label')];
    for (const label of labels) {
      label.style.marginTop = '';
      label.style.marginLeft = '';
      const box = label.getBoundingClientRect();
      if (box.top < top + 6) label.style.marginTop = `${top + 6 - box.top}px`;
      else if (box.bottom > bottom - 6) label.style.marginTop = `${bottom - 6 - box.bottom}px`;
      const leftEdge = Math.max(0, frame.left) + 6, rightEdge = Math.min(innerWidth, frame.right) - 6;
      if (box.left < leftEdge) label.style.marginLeft = `${leftEdge - box.left}px`;
      else if (box.right > rightEdge) label.style.marginLeft = `${rightEdge - box.right}px`;
    }
    // Two labels on top of each other: the lower one steps down until they part.
    const boxes = labels.map(label => ({ label, box: label.getBoundingClientRect() })).sort((a, b) => a.box.top - b.box.top);
    for (let i = 1; i < boxes.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = boxes[j].box, b = boxes[i].box;
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && a.bottom + 4 > b.top;
        if (!overlap) continue;
        const shift = a.bottom + 4 - b.top;
        const label = boxes[i].label;
        label.style.marginTop = `${(parseFloat(label.style.marginTop) || 0) + shift}px`;
        boxes[i].box = label.getBoundingClientRect();
      }
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
      const spotAt = labelPlacement(spot);
      label.style.left = `${spotAt.x * 100}%`;
      label.style.top = `${spotAt.y * 100}%`;
      label.dataset.anchor = spotAt.anchor;
      label.append(el('span', 'eyebrow', this.eyebrow(spot)), el('span', 'action', spot.label));
      if (spot.hint) label.append(el('span', 'hint', spot.hint));
      clickable(label);
      label.addEventListener('focus', () => light(true));
      label.addEventListener('blur', () => light(false));
      if (spot.next) group.classList.add('next');
      if (spot.collect) group.classList.add('collectible');
      if (spot.shortcut) group.classList.add('shortcut');
      if (this.played(spot)) group.classList.add('played');
      group.append(label);
      this.layer.append(group);
    }
    this.layer.hidden = false;
    // Each place starts with every label showing.
    this.setLabels(true);
    requestAnimationFrame(() => this.keepClear());
  }

  hide() {
    this.layer.hidden = true;
  }

  private setLabels(on: boolean) {
    this.labelsHidden = !on;
    this.layer.classList.toggle('labels-on', on);
  }

  private eyebrow(spot: Hotspot) {
    if (spot.collect) return this.collected(spot) ? (spot.figure ? 'Collected · turn it over' : 'Collected') : 'Collect this figure';
    if (spot.figure) return 'Turn it over in 3D';
    if (!spot.to) return 'Moment';
    const destination = this.world.places.find(place => place.id === spot.to);
    // Never give away where a choice leads when it ends the story.
    if (destination?.ending) return 'A choice';
    const title = destination?.title ?? spot.to;
    if (spot.next) return `Next stop · ${title}`;
    if (spot.shortcut) return `Shortcut to ${title}`;
    return `To ${title}`;
  }
}
