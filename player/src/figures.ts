// Figures: a collectible stood up in 3D. Finding one lets the visitor pick it
// up and turn it over; it then joins their collection, where the ones still
// hidden show only as silhouettes.
//
// `@google/model-viewer` is about a megabyte of 3D engine. It is imported the
// first time a visitor opens a figure, never on the way into a world, so the
// cost lands only on the people who want it.
import { el } from './stage';
import type { Hotspot, Place, World } from './world';

export type Figure = { key: string; place: Place; spot: Hotspot; name: string; model: string; icon?: string };

/** Every figure in the world, in story order. */
export function figuresOf(world: World): Figure[] {
  const order = world.order ?? world.places.map(place => place.id);
  const places = order.map(id => world.places.find(place => place.id === id)).filter((place): place is Place => Boolean(place));
  return places.flatMap(place => place.hotspots
    .filter(spot => spot.collect && spot.figure?.model)
    .map(spot => ({ key: `${place.id}/${spot.id}`, place, spot, name: spot.figure!.name ?? spot.label, model: spot.figure!.model, icon: spot.figure!.icon })));
}

/** model-viewer reads attributes, not properties: setting them by hand is what loads the model. */
const VIEWER = {
  'camera-controls': '', 'auto-rotate': '', 'touch-action': 'pan-y', 'interaction-prompt': 'none',
  // `loading`, not `reveal`: the visitor asked to see it, so fetch it now.
  loading: 'eager',
  'environment-image': 'neutral', 'tone-mapping': 'neutral', exposure: '1.15', 'shadow-intensity': '1.1', 'shadow-softness': '0.75',
};
const LOAD_TIMEOUT_MS = 30_000;

/** Turn one figure over. Resolves when the visitor closes it. */
export function inspect(root: HTMLElement, figure: Figure): Promise<void> {
  return new Promise(resolve => {
    const dialog = el('section', 'inspector');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `${figure.name} in three dimensions`);
    const stage = el('div', 'inspector-stage');
    const state = el('p', 'inspector-state', 'Picking it up…');
    stage.append(state);
    const bar = el('div', 'inspector-bar');
    const close = el('button', 'pill primary', 'Put it down');
    close.type = 'button';
    bar.append(el('span', 'inspector-name', figure.name), el('span', 'inspector-help', 'Drag to turn it over'), close);
    dialog.append(stage, bar);
    root.append(dialog);
    close.focus();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', escape);
      dialog.remove();
      resolve();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); done(); } };
    window.addEventListener('keydown', escape);
    close.addEventListener('click', done);
    dialog.addEventListener('click', event => { if (event.target === dialog) done(); });

    const fail = () => { if (state.isConnected && !state.hidden) state.textContent = 'This figure could not be shown here.'; };
    import('@google/model-viewer').then(() => {
      if (!dialog.isConnected) return;
      const viewer = document.createElement('model-viewer');
      for (const [name, value] of Object.entries(VIEWER)) viewer.setAttribute(name, value);
      viewer.setAttribute('alt', figure.name);
      if (figure.icon) viewer.setAttribute('poster', figure.icon);
      timer = setTimeout(fail, LOAD_TIMEOUT_MS);
      viewer.addEventListener('load', () => { clearTimeout(timer); state.hidden = true; });
      viewer.addEventListener('error', fail);
      viewer.setAttribute('src', figure.model);
      stage.append(viewer);
    }).catch(fail);
  });
}

/** The moment a figure joins the collection: not a modal, it never blocks the way on. */
export function foundCard(root: HTMLElement, figure: Figure, found: number, total: number, openCollection: () => void) {
  root.querySelector('.found-card')?.remove();
  const card = el('section', 'found-card');
  card.setAttribute('role', 'status');
  const left = total - found;
  card.append(
    el('p', 'eyebrow', `Collected · ${found} of ${total}`),
    el('strong', 'found-name', figure.name),
    el('p', 'found-left', left === 0 ? 'Every figure found. The whole set is yours to turn over.' : `${left} ${left === 1 ? 'figure' : 'figures'} still hidden in this world.`),
  );
  const actions = el('div', 'found-actions');
  const see = el('button', 'pill', 'Your collection');
  see.type = 'button';
  see.addEventListener('click', () => { card.remove(); openCollection(); });
  const keep = el('button', 'pill primary', 'Keep exploring');
  keep.type = 'button';
  keep.addEventListener('click', () => card.remove());
  actions.append(see, keep);
  card.append(actions);
  root.append(card);
  setTimeout(() => card.remove(), 9000);
}

/** The collection: found figures to turn over again, and silhouettes of the ones still hidden. */
export function collectionCard(figures: Figure[], found: Set<string>, open: (figure: Figure) => void): HTMLElement {
  const card = el('div', 'panel-card');
  const count = figures.filter(figure => found.has(figure.key)).length;
  card.append(el('h2', '', 'Your collection'), el('p', '', `${count} of ${figures.length} found. Click a figure to turn it over.`));
  const grid = el('ul', 'figure-grid');
  for (const figure of figures) {
    const have = found.has(figure.key);
    const item = el('li');
    const button = el('button', `figure-tile${have ? '' : ' hidden-figure'}`);
    button.type = 'button';
    if (figure.icon) {
      const image = el('img');
      image.src = figure.icon;
      image.alt = '';
      image.loading = 'lazy';
      button.append(image);
    } else button.append(el('span', 'figure-unknown', '?'));
    button.append(el('span', 'figure-name', have ? figure.name : 'Still hidden'));
    if (have) button.addEventListener('click', () => open(figure));
    else button.disabled = true;
    item.append(button);
    grid.append(item);
  }
  card.append(grid);
  return card;
}
