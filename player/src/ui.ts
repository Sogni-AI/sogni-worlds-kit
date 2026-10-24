// Everything around the picture: where you are, the buttons, the Map and
// About panels, the Begin screen and the keyboard.
import { el } from './stage';
import type { Details, Place, Quality, World } from './world';

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
  /** Play on after something outside the world paused the film. */
  resume: () => void;
  jump: (placeId: string) => void;
  toggleSound: () => void;
  setMusicLevel: (level: number) => void;
  setQuality: (quality: Quality) => void;
  restart: () => void;
  collection: () => void;
};

export class Ui {
  private readonly where = el('div', 'where');
  private readonly nextButton = el('button', 'pill primary');
  private readonly backButton = el('button', 'pill', '← Back');
  private readonly skipButton = el('button', 'pill', 'Skip ›');
  /** A film paused from outside the world (a media key, AirPods taken out): one tap plays on. */
  private readonly playButton = el('button', 'pill primary', '▶ Play');
  /** Held on a close look: the one way back to the place. */
  private readonly doneButton = el('button', 'pill primary');
  /** When Skip last appeared: a second tap on the button that was just there must not skip the next film. */
  private skipShownAt = 0;
  private readonly soundButton = el('button', 'icon-button');
  private readonly qualityButton = el('button', 'icon-button text');
  private readonly mapPanel = el('section', 'panel');
  private readonly aboutPanel = el('section', 'panel');
  private readonly caption = el('p', 'caption');
  private captionTimer?: ReturnType<typeof setTimeout>;
  private readonly ending = el('section', 'ending');
  private readonly collection = el('button', 'collection-pill');
  private readonly collectionPanel = el('section', 'panel');
  private readonly toastBox = el('p', 'toast');
  private toastTimer?: ReturnType<typeof setTimeout>;
  private readonly slowBox = el('div', 'slow');
  private readonly slowText = el('span', 'text');
  private readonly slowButton = el('button', '', 'Switch to 720p');
  private readonly detailsCard = el('aside', 'details-card');

  constructor(private readonly root: HTMLElement, private readonly world: World, private readonly actions: Actions, musicPresent: boolean, musicCredit?: string) {
    const top = el('header', 'bar top');
    const buttons = el('div', 'buttons');
    this.soundButton.addEventListener('click', actions.toggleSound);
    this.qualityButton.addEventListener('click', () => actions.setQuality(this.qualityButton.dataset.quality === '2k' ? '720' : '2k'));
    this.qualityButton.title = 'Picture quality';
    buttons.append(this.soundButton);
    if (musicPresent) buttons.append(this.musicControl());
    // The maker sees a draft marked while playing it locally; a visitor finds the note in About.
    if (world.draft && import.meta.env.DEV) buttons.prepend(el('span', 'draft-chip', 'Draft · not yet approved'));
    this.collection.hidden = true;
    this.collection.type = 'button';
    this.collection.title = 'Your collection';
    this.collection.addEventListener('click', actions.collection);
    buttons.prepend(this.collection);
    buttons.append(this.qualityButton);
    if (world.map !== false) buttons.append(this.iconButton('map', 'Places', () => this.toggle(this.mapPanel)));
    buttons.append(this.iconButton('about', 'About this world', () => this.toggle(this.aboutPanel)));
    // iPhone Safari has no full screen for a page: offer the button only where it works.
    if (document.fullscreenEnabled) buttons.append(this.iconButton('full', 'Full screen', () => toggleFullscreen()));
    top.append(this.where, buttons);

    const bottom = el('footer', 'bar bottom');
    this.backButton.addEventListener('click', actions.back);
    this.skipButton.addEventListener('click', () => this.skipIfMeant());
    this.playButton.addEventListener('click', actions.resume);
    this.nextButton.addEventListener('click', actions.next);
    // Nothing to go back to, skip or go on to until the first place has arrived.
    for (const button of [this.backButton, this.playButton, this.skipButton, this.doneButton, this.nextButton]) { button.type = 'button'; button.hidden = true; }
    bottom.append(this.backButton, this.playButton, this.skipButton, this.doneButton, this.nextButton);

    this.buildAbout(musicCredit);
    for (const panel of [this.mapPanel, this.aboutPanel, this.collectionPanel]) {
      panel.hidden = true;
      panel.addEventListener('click', event => { if (event.target === panel) panel.hidden = true; });
    }
    this.ending.hidden = true;
    this.toastBox.hidden = true;
    this.slowBox.hidden = true;
    this.slowBox.setAttribute('role', 'status');
    this.slowButton.type = 'button';
    this.slowButton.addEventListener('click', () => actions.setQuality('720'));
    this.slowBox.append(el('span', 'spinner'), this.slowText, this.slowButton);
    this.detailsCard.hidden = true;
    this.detailsCard.setAttribute('aria-live', 'polite');
    root.append(top, bottom, this.ending, this.toastBox, this.slowBox, this.detailsCard, this.mapPanel, this.aboutPanel, this.collectionPanel);
    this.turnHint();
    this.keyboard();
  }

  /**
   * A film starved of bytes: say so, with how much has arrived, and offer the
   * lighter picture when the visitor is on 2K. Never skip it for them.
   */
  slow(state: { loaded: number | null; quality: Quality } | null) {
    this.slowBox.hidden = !state;
    if (!state) return;
    const here = state.loaded !== null ? `: ${Math.round(state.loaded * 100)}% of the film is here` : '';
    this.slowText.textContent = `Slow connection${here}. It plays through; nothing is skipped.`;
    this.slowButton.hidden = state.quality !== '2k';
  }

  /** The film was paused by something outside the world, or plays again. */
  interrupted(on: boolean) {
    this.playButton.hidden = !on;
    if (on) this.playButton.focus({ preventScroll: true });
  }

  /** The visitor's collection: found / total, shown once the world has collectibles. */
  setCollection(found: number, total: number) {
    this.collection.hidden = total === 0;
    this.collection.textContent = `Figures ${found}/${total}`;
  }

  /** Open the collection panel with this card in it. */
  showCollection(card: HTMLElement) {
    this.closePanels();
    this.collectionPanel.replaceChildren(card);
    this.collectionPanel.hidden = false;
  }

  /** A short message over the picture. */
  toast(text: string, ms = 3200) {
    clearTimeout(this.toastTimer);
    this.toastBox.textContent = text;
    this.toastBox.hidden = false;
    this.toastTimer = setTimeout(() => { this.toastBox.hidden = true; }, ms);
  }

  /** The story stopped here: a death (Rewind chooses again) or an ending. */
  showEnding(ending: NonNullable<Place['ending']>, canRewind: boolean, rewindTitle?: string) {
    const card = el('div', 'ending-card');
    card.append(el('p', 'eyebrow', ending.kind === 'death' ? 'You died' : 'The end'), el('h2', '', ending.title));
    if (ending.text) card.append(el('p', 'lede', ending.text));
    const choices = el('div', 'choices');
    if (canRewind) {
      const rewind = el('button', 'pill primary big', ending.kind === 'death' ? 'Rewind · choose again' : 'Go back');
      rewind.type = 'button';
      if (rewindTitle) rewind.title = `Back to ${rewindTitle}`;
      rewind.addEventListener('click', () => { this.hideEnding(); this.actions.back(); });
      choices.append(rewind);
    }
    const restart = el('button', 'pill', 'Start over');
    restart.type = 'button';
    restart.addEventListener('click', () => { this.hideEnding(); this.actions.restart(); });
    choices.append(restart);
    card.append(choices);
    this.ending.replaceChildren(card);
    this.ending.dataset.kind = ending.kind;
    this.ending.hidden = false;
    this.nextButton.hidden = true;
    this.backButton.hidden = true;
    (choices.firstElementChild as HTMLElement | null)?.focus();
  }

  /** An object's card: what it is, beside its film, until closed or the visitor moves on. */
  showDetails(details: Details) {
    const close = el('button', 'details-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.hideDetails());
    const parts: HTMLElement[] = [close];
    if (details.title) parts.push(el('h2', '', details.title));
    parts.push(el('p', 'details-text', details.text));
    if (details.facts?.length) {
      const facts = el('dl');
      for (const [label, value] of details.facts) facts.append(el('dt', '', label), el('dd', '', value));
      parts.push(facts);
    }
    this.detailsCard.replaceChildren(...parts);
    this.detailsCard.hidden = false;
  }

  hideDetails() {
    this.detailsCard.hidden = true;
  }

  hideEnding() {
    this.ending.hidden = true;
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

  /**
   * Held on a close look while its line is said: one button (the plan's words,
   * "Set the glove down") takes the visitor back to the place, as does Escape.
   * Nothing moves on by itself; the visitor looks as long as they like.
   */
  waitForDone(label: string): Promise<void> {
    this.holding();
    this.doneButton.textContent = label;
    this.doneButton.hidden = false;
    this.doneButton.focus({ preventScroll: true });
    return new Promise(resolve => {
      const finish = () => {
        this.doneButton.hidden = true;
        this.doneButton.removeEventListener('click', finish);
        window.removeEventListener('keydown', escape, true);
        resolve();
      };
      // Escape closes an open panel first, as it does everywhere else.
      const escape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || this.root.querySelector('.panel:not([hidden])')) return;
        event.stopPropagation();
        finish();
      };
      this.doneButton.addEventListener('click', finish);
      window.addEventListener('keydown', escape, true);
    });
  }

  /** Held on a close look: there is no film to skip, and its line is read above anything else on screen. */
  holding() {
    this.skipButton.hidden = true;
    this.root.classList.add('holding');
  }

  private skipIfMeant() {
    if (performance.now() - this.skipShownAt > 600) this.actions.skip();
  }

  /** While a film plays only Skip is offered. */
  filmPlaying(on: boolean) {
    this.root.classList.toggle('in-film', on);
    this.root.classList.remove('holding');
    if (on && this.skipButton.hidden) this.skipShownAt = performance.now();
    this.skipButton.hidden = !on;
    if (!on) this.playButton.hidden = true;
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
    this.collectionPanel.hidden = true;
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

  /**
   * The world drawn as its pictures. A story told in order is the trip, one
   * picture after the next, numbered; a free world is a grid of its places.
   * The place you are in is marked, and the ones you have seen are ticked.
   */
  private renderMap(current: string, visited: Set<string>) {
    const card = el('div', 'panel-card map-card');
    const linear = Boolean(this.world.order);
    card.append(el('h2', '', linear ? 'The trip' : 'Places'));
    const list = el('ol', `trip${linear ? '' : ' free'}`);
    const ids = this.world.order ?? this.world.places.map(place => place.id);
    for (const id of ids) {
      const place = this.world.places.find(p => p.id === id);
      if (!place) continue;
      const item = el('li');
      const button = el('button', `trip-stop${id === current ? ' current' : ''}${visited.has(id) ? ' visited' : ''}`);
      button.type = 'button';
      const picture = el('img') as HTMLImageElement;
      picture.src = place.still;
      picture.alt = '';
      picture.loading = 'lazy';
      button.append(picture, el('span', 'title', place.title));
      if (place.chapter) button.append(el('span', 'chapter', place.chapter));
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
    if (this.world.draft) card.append(el('p', 'small', 'A draft: its maker has not yet approved every film in it.'));
    const made = el('p');
    made.innerHTML = `Made with <a href="https://www.sogni.ai" target="_blank" rel="noopener">Sogni</a>. Build your own from your photos, with your own coding agent: <a href="${REPO}" target="_blank" rel="noopener">sogni-worlds-kit</a>.`;
    const more = el('p', 'small');
    more.innerHTML = '<a href="https://worlds.sogni.ai/how-this-was-made" target="_blank" rel="noopener">How the official worlds were made</a> · '
      + '<a href="https://blog.sogni.ai/blogs/how-agents-built-sogni-world/" target="_blank" rel="noopener">How agents built Sogni World</a> · '
      + '<a href="https://worlds.sogni.ai" target="_blank" rel="noopener">worlds.sogni.ai</a>';
    const keys = el('p', 'small keys', `Click the picture itself to hide or show the labels. Keys: N next stop · B back · S skip film · M sound${document.fullscreenEnabled ? ' · F full screen' : ''} · Esc close`);
    card.append(made, more, keys);
    this.aboutPanel.append(card);
  }

  /**
   * A landscape world on a phone held upright is a strip across the middle of
   * the screen: say once, under the picture, that turning the phone shows it
   * whole. The note shows only while the phone is upright (styles.css) and
   * stays away once closed.
   */
  private turnHint() {
    if (this.world.aspect.width <= this.world.aspect.height) return;
    try { if (localStorage.getItem('sogni-world:turn-hint') === 'closed') return; } catch { /* private window */ }
    const hint = el('p', 'turn-hint', 'Turn your phone sideways for the whole picture');
    const close = el('button', '', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => {
      hint.remove();
      try { localStorage.setItem('sogni-world:turn-hint', 'closed'); } catch { /* private window */ }
    });
    hint.append(close);
    (this.root.querySelector('.frame') ?? this.root).append(hint);
  }

  private keyboard() {
    window.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement)?.tagName === 'INPUT') return;
      // A figure being turned over is a dialog: the world's keys wait until it is put down.
      if (this.root.querySelector('.inspector')) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') this.closePanels();
      else if (key === 'n') this.actions.next();
      else if (key === 'b') this.actions.back();
      else if (key === 's') this.skipIfMeant();
      else if (key === 'm') this.actions.toggleSound();
      else if (key === 'f' && document.fullscreenEnabled) toggleFullscreen();
    });
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

/** The first screen: the world's name over its first picture, and Begin. */
export function beginScreen(root: HTMLElement, world: World, still: string, onGesture?: () => void): Promise<void> {
  return new Promise(resolve => {
    const screen = el('section', 'begin');
    screen.style.backgroundImage = `url("${still}")`;
    const card = el('div', 'begin-card');
    const intro = world.intro ?? {};
    card.append(el('p', 'eyebrow', intro.eyebrow ?? 'A Sogni World'), el('h1', '', world.title));
    if (intro.tagline ?? world.subtitle) card.append(el('p', 'lede', intro.tagline ?? world.subtitle ?? ''));
    if (intro.warning) card.append(el('p', 'warning', intro.warning));
    const button = el('button', 'pill primary big', intro.begin ?? 'Begin');
    button.type = 'button';
    card.append(button, el('p', 'small', 'Best with sound on. Click the things in each picture.'));
    screen.append(card);
    root.append(screen);
    button.focus();
    button.addEventListener('click', () => {
      onGesture?.(); // synchronously, inside the tap: see Player.unlockMedia
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
