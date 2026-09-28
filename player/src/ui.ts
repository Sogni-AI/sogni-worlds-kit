// Everything around the picture: where you are, the buttons, the Map and
// About panels, the Begin screen and the keyboard.
import { el } from './stage';
import type { Place, Quality, World } from './world';

const REPO = 'https://github.com/Sogni-AI/sogni-worlds-kit';

const ICONS = {
  sound: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  music: '<path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4v14M15 6v14" stroke="currentColor" stroke-width="1.8"/>',
  about: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

export const icon = (name: keyof typeof ICONS) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${ICONS[name]}</svg>`;

export type Actions = {
  next: () => void;
  back: () => void;
  skip: () => void;
  jump: (placeId: string) => void;
  toggleSound: () => void;
  setMusicLevel: (level: number) => void;
  setQuality: (quality: Quality) => void;
};

export class Ui {
  private readonly where = el('div', 'where');
  private readonly nextButton = el('button', 'pill primary');
  private readonly backButton = el('button', 'pill', '← Back');
  private readonly skipButton = el('button', 'pill', 'Skip ›');
  private readonly soundButton = el('button', 'icon-button');
  private readonly qualityButton = el('button', 'icon-button text');
  private readonly mapPanel = el('section', 'panel');
  private readonly aboutPanel = el('section', 'panel');
  private readonly caption = el('p', 'caption');
  private captionTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly root: HTMLElement, private readonly world: World, private readonly actions: Actions, musicPresent: boolean, musicCredit?: string) {
    const top = el('header', 'bar top');
    const buttons = el('div', 'buttons');
    this.soundButton.addEventListener('click', actions.toggleSound);
    this.qualityButton.addEventListener('click', () => actions.setQuality(this.qualityButton.dataset.quality === '2k' ? '720' : '2k'));
    this.qualityButton.title = 'Picture quality';
    buttons.append(this.soundButton);
    if (musicPresent) buttons.append(this.musicControl());
    buttons.append(this.qualityButton, this.iconButton('map', 'Places', () => this.toggle(this.mapPanel)),
      this.iconButton('about', 'About this world', () => this.toggle(this.aboutPanel)),
      this.iconButton('full', 'Full screen', () => toggleFullscreen()));
    top.append(this.where, buttons);

    const bottom = el('footer', 'bar bottom');
    this.backButton.addEventListener('click', actions.back);
    this.skipButton.addEventListener('click', actions.skip);
    this.nextButton.addEventListener('click', actions.next);
    for (const button of [this.backButton, this.skipButton, this.nextButton]) button.type = 'button';
    bottom.append(this.backButton, this.skipButton, this.nextButton);

    this.buildAbout(musicCredit);
    for (const panel of [this.mapPanel, this.aboutPanel]) {
      panel.hidden = true;
      panel.addEventListener('click', event => { if (event.target === panel) panel.hidden = true; });
    }
    root.append(top, bottom, this.mapPanel, this.aboutPanel);
    this.keyboard();
  }

  /** Arrived somewhere: say where, offer the next stop and Back. */
  setPlace(place: Place, nextTitle: string | undefined, canGoBack: boolean, visited: Set<string>) {
    const where = el('span', 'place', place.title);
    if (place.chapter) where.prepend(el('span', 'chapter', `${place.chapter} · `));
    this.where.replaceChildren(el('span', 'world-title', this.world.title), where, this.caption);
    this.nextButton.hidden = !nextTitle;
    this.nextButton.textContent = nextTitle ? `Next stop · ${nextTitle} →` : '';
    this.backButton.hidden = !canGoBack;
    this.skipButton.hidden = true;
    this.renderMap(place.id, visited);
    clearTimeout(this.captionTimer);
    this.caption.textContent = place.caption ?? '';
    this.caption.hidden = !place.caption;
    this.captionTimer = setTimeout(() => { this.caption.hidden = true; }, 9000);
  }

  /** While a film plays only Skip is offered. */
  filmPlaying(on: boolean) {
    this.root.classList.toggle('in-film', on);
    this.skipButton.hidden = !on;
    if (on) {
      this.nextButton.hidden = true;
      this.backButton.hidden = true;
      this.caption.hidden = true;
    }
  }

  setSound(on: boolean) {
    this.soundButton.innerHTML = icon(on ? 'sound' : 'mute');
    this.soundButton.title = on ? 'Sound on (M)' : 'Sound off (M)';
    this.soundButton.setAttribute('aria-label', this.soundButton.title);
  }

  setQuality(quality: Quality) {
    this.qualityButton.dataset.quality = quality;
    this.qualityButton.textContent = quality === '2k' ? '2K' : '720p';
  }

  closePanels() {
    this.mapPanel.hidden = true;
    this.aboutPanel.hidden = true;
  }

  private iconButton(name: keyof typeof ICONS, title: string, onClick: () => void) {
    const button = el('button', 'icon-button');
    button.type = 'button';
    button.innerHTML = icon(name);
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  private musicControl() {
    const wrap = el('div', 'music-control');
    const button = this.iconButton('music', 'Music volume', () => wrap.classList.toggle('open'));
    const slider = el('input', 'volume') as HTMLInputElement;
    Object.assign(slider, { type: 'range', min: '0', max: '2', step: '0.05', value: '1' });
    slider.setAttribute('aria-label', 'Music volume');
    slider.addEventListener('input', () => this.actions.setMusicLevel(Number(slider.value)));
    wrap.append(button, slider);
    return wrap;
  }

  private toggle(panel: HTMLElement) {
    const opening = panel.hidden;
    this.closePanels();
    panel.hidden = !opening;
  }

  private renderMap(current: string, visited: Set<string>) {
    const card = el('div', 'panel-card');
    card.append(el('h2', '', 'Places'));
    const list = el('ol', 'places');
    const ids = this.world.order ?? this.world.places.map(place => place.id);
    for (const id of ids) {
      const place = this.world.places.find(p => p.id === id);
      if (!place) continue;
      const item = el('li');
      const button = el('button', `place-link${id === current ? ' current' : ''}${visited.has(id) ? ' visited' : ''}`);
      button.type = 'button';
      button.append(el('span', 'title', place.title), el('span', 'chapter', place.chapter ?? ''));
      button.addEventListener('click', () => {
        this.mapPanel.hidden = true;
        this.actions.jump(id);
      });
      item.append(button);
      list.append(item);
    }
    card.append(list);
    this.mapPanel.replaceChildren(card);
  }

  private buildAbout(musicCredit?: string) {
    const card = el('div', 'panel-card');
    card.append(el('h2', '', this.world.title));
    if (this.world.subtitle) card.append(el('p', 'lede', this.world.subtitle));
    if (this.world.credit) card.append(el('p', '', this.world.credit));
    if (musicCredit) card.append(el('p', 'small', `Music: ${musicCredit}`));
    const made = el('p');
    made.innerHTML = `Made with <a href="https://www.sogni.ai" target="_blank" rel="noopener">Sogni</a>. Build your own from your photos, with your own coding agent: <a href="${REPO}" target="_blank" rel="noopener">sogni-worlds-kit</a>.`;
    const more = el('p', 'small');
    more.innerHTML = '<a href="https://worlds.sogni.ai/how-this-was-made" target="_blank" rel="noopener">How the official worlds were made</a> · '
      + '<a href="https://blog.sogni.ai/blogs/how-agents-built-sogni-world/" target="_blank" rel="noopener">How agents built Sogni World</a> · '
      + '<a href="https://worlds.sogni.ai" target="_blank" rel="noopener">worlds.sogni.ai</a>';
    const keys = el('p', 'small keys', 'Keys: N next stop · B back · S skip film · M sound · F full screen · Esc close');
    card.append(made, more, keys);
    this.aboutPanel.append(card);
  }

  private keyboard() {
    window.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement)?.tagName === 'INPUT') return;
      const key = event.key.toLowerCase();
      if (key === 'escape') this.closePanels();
      else if (key === 'n') this.actions.next();
      else if (key === 'b') this.actions.back();
      else if (key === 's') this.actions.skip();
      else if (key === 'm') this.actions.toggleSound();
      else if (key === 'f') toggleFullscreen();
    });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** The first screen: the world's name over its first picture, and Begin. */
export function beginScreen(root: HTMLElement, world: World, still: string): Promise<void> {
  return new Promise(resolve => {
    const screen = el('section', 'begin');
    screen.style.backgroundImage = `url("${still}")`;
    const card = el('div', 'begin-card');
    card.append(el('p', 'eyebrow', 'A Sogni World'), el('h1', '', world.title));
    if (world.subtitle) card.append(el('p', 'lede', world.subtitle));
    const button = el('button', 'pill primary big', 'Begin');
    button.type = 'button';
    card.append(button, el('p', 'small', 'Best with sound on. Click the things in each picture.'));
    screen.append(card);
    root.append(screen);
    button.focus();
    button.addEventListener('click', () => {
      screen.remove();
      resolve();
    }, { once: true });
  });
}

export function errorScreen(root: HTMLElement, message: string) {
  const screen = el('section', 'begin error');
  const card = el('div', 'begin-card');
  card.append(el('p', 'eyebrow', 'This world could not open'), el('p', '', message),
    el('p', 'small', 'Building your own? Run `node world build <id>` and then `node world play <id>`.'));
  screen.append(card);
  root.replaceChildren(screen);
}
