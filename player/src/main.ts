// The Sogni World player: load a world.json, show its first place, and let the
// visitor travel by clicking things in the pictures.
import './styles.css';
import { collectionCard, figuresOf, foundCard, inspect, type Figure } from './figures';
import { Hotspots } from './hotspots';
import { Music } from './music';
import { Narration } from './narration';
import { Stage } from './stage';
import { beginScreen, errorScreen, Ui } from './ui';
import { loadWorld, nextStop, placeOf, worldUrl, type Hotspot, type Place, type Quality, type World } from './world';

/** Seconds of quiet before the first place speaks, and between later arrivals and their narration. */
const FIRST_NARRATION_MS = 3000;
const NARRATION_MS = 400;

const store = {
  get: (key: string) => { try { return localStorage.getItem(`sogni-world:${key}`); } catch { return null; } },
  set: (key: string, value: string) => { try { localStorage.setItem(`sogni-world:${key}`, value); } catch { /* private window */ } },
};

class Player {
  private place!: Place;
  /** How the visitor got here: each crossing taken, so Back can play it in reverse. */
  private readonly history: { from: string; spot: Hotspot }[] = [];
  private readonly visited = new Set<string>();
  /** Collectibles found, as "<place>/<object>", kept per world in the visitor's browser. */
  private readonly collection: Set<string>;
  private readonly collectibles: number;
  private readonly figures: Figure[];
  private busy = false;
  private soundOn = store.get('sound') !== 'off';
  private readonly stage: Stage;
  private readonly hotspots: Hotspots;
  private readonly narration: Narration;
  private readonly music: Music;
  private readonly ui: Ui;

  constructor(private readonly root: HTMLElement, private readonly world: World) {
    document.title = world.title;
    this.stage = new Stage(root, world);
    this.stage.quality = (store.get('quality') as Quality | null) ?? defaultQuality();
    this.collection = new Set(readList(store.get(`collection:${world.id}`)));
    this.collectibles = world.places.reduce((n, place) => n + place.hotspots.filter(spot => spot.collect).length, 0);
    this.figures = figuresOf(world);
    this.hotspots = new Hotspots(this.stage.overlay, world, spot => void this.go(spot), spot => this.collection.has(`${this.place?.id}/${spot.id}`));
    this.narration = new Narration(root, world);
    this.music = new Music(world.music);
    this.narration.onSpeaking = speaking => this.music.duck(speaking || this.stage.playingFilm);
    this.ui = new Ui(root, world, {
      next: () => { const spot = nextStop(this.place); if (spot) void this.go(spot); },
      back: () => void this.back(),
      skip: () => this.stage.skip(),
      jump: id => void this.jump(id),
      toggleSound: () => this.setSound(!this.soundOn),
      setMusicLevel: level => this.music.setLevel(level),
      setQuality: quality => this.setQuality(quality),
      restart: () => void this.restart(),
      collection: () => this.showCollection(),
    }, this.music.present, this.music.credit);
    this.ui.setQuality(this.stage.quality);
    this.ui.setCollection(this.collection.size, this.collectibles);
    this.setSound(this.soundOn);
  }

  /**
   * Called synchronously inside the Begin tap. iOS Safari lets a media element
   * play with sound on its own later only if play() was first called on that
   * element during a user gesture; the loop hand-offs, films, rewinds and
   * narration all start later from timers and 'ended' events. So every element
   * is played and paused once, here, whether or not it has a source yet.
   */
  unlockMedia() {
    const elements: (HTMLMediaElement | undefined)[] = [...this.stage.mediaElements, this.narration.element, this.music.element];
    for (const media of elements) {
      if (!media) continue;
      const attempt = media.play();
      if (attempt) attempt.catch(() => undefined);
      media.pause();
    }
  }

  async begin() {
    this.music.start();
    await this.arrive(placeOf(this.world, this.world.start), FIRST_NARRATION_MS, true);
  }

  /**
   * Be somewhere: show it (unless a film already landed on it), then offer its
   * ways on. `narrationDelay` null means stay quiet (back from a moment here).
   */
  private async arrive(place: Place, narrationDelay: number | null, show: boolean) {
    this.place = place;
    this.visited.add(place.id);
    if (show) await this.stage.show(place);
    this.hotspots.render(place);
    const next = nextStop(place);
    const nextTitle = next?.to ? placeOf(this.world, next.to).title : undefined;
    this.ui.setPlace(place, nextTitle, this.history.length > 0 && !place.ending, this.visited);
    if (narrationDelay !== null) this.narration.start(place, narrationDelay);
    this.stage.preload(next?.film);
    if (place.ending) {
      const from = this.history.at(-1)?.from;
      this.ui.showEnding(place.ending, this.history.length > 0, from ? placeOf(this.world, from).title : undefined);
    } else this.ui.hideEnding();
  }

  /** Play the film an object causes, then land where it leads (or back here, for a moment). */
  private async go(spot: Hotspot) {
    if (this.busy) return;
    this.busy = true;
    const from = this.place;
    const landing = spot.to ? placeOf(this.world, spot.to) : from;
    this.beforeFilm();
    let found = false;
    try {
      if (spot.film) await this.stage.play(spot.film, landing);
      if (spot.to) this.history.push({ from: from.id, spot });
      if (spot.collect) found = this.collect(from, spot);
    } catch (error) {
      console.error('The film could not play', error);
      await this.stage.show(landing);
    } finally {
      this.afterFilm();
    }
    await this.arrive(landing, spot.to ? NARRATION_MS : null, false);
    // A figure is picked up and turned over first; the collection card waits until it is put down.
    const figure = spot.collect ? this.figures.find(f => f.key === `${from.id}/${spot.id}`) : undefined;
    if (figure) {
      await inspect(this.root, figure);
      if (found) foundCard(this.root, figure, this.collection.size, this.collectibles, () => this.showCollection());
    }
  }

  private showCollection() {
    this.ui.showCollection(collectionCard(this.figures, this.collection, figure => void inspect(this.root, figure)));
  }

  /** Back the way you came: the crossing played in reverse when there is one. */
  private async back() {
    const last = this.history.at(-1);
    if (!last || this.busy) return;
    this.busy = true;
    this.history.pop();
    const previous = placeOf(this.world, last.from);
    this.beforeFilm();
    try {
      if (last.spot.rewind) await this.stage.play(last.spot.rewind, previous);
      else await this.stage.show(previous);
    } finally {
      this.afterFilm();
    }
    await this.arrive(previous, NARRATION_MS, false);
  }

  /** A collectible's moment has played: it joins the collection. True the first time. */
  private collect(place: Place, spot: Hotspot): boolean {
    const key = `${place.id}/${spot.id}`;
    if (this.collection.has(key)) return false;
    this.collection.add(key);
    store.set(`collection:${this.world.id}`, JSON.stringify([...this.collection]));
    this.ui.setCollection(this.collection.size, this.collectibles);
    // A figure gets its own card once it is put down; a collectible without one is announced here.
    if (!spot.figure) this.ui.toast(`Collected: ${spot.label} · ${this.collection.size} of ${this.collectibles}`);
    return true;
  }

  /** Start over from the first place (an ending's second choice). */
  private async restart() {
    if (this.busy) return;
    this.narration.stop();
    this.history.length = 0;
    await this.arrive(placeOf(this.world, this.world.start), NARRATION_MS, true);
  }

  /** From the Places panel: go straight there. */
  private async jump(id: string) {
    if (this.busy || id === this.place.id) return;
    this.narration.stop();
    this.history.length = 0;
    await this.arrive(placeOf(this.world, id), NARRATION_MS, true);
  }

  private beforeFilm() {
    this.narration.stop();
    this.hotspots.hide();
    this.ui.closePanels();
    this.ui.filmPlaying(true);
    this.music.duck(true);
  }

  private afterFilm() {
    this.ui.filmPlaying(false);
    this.music.duck(false);
    this.busy = false;
  }

  private setSound(on: boolean) {
    this.soundOn = on;
    store.set('sound', on ? 'on' : 'off');
    this.stage.setSound(1, !on);
    this.narration.setSound(1, !on);
    this.music.setMuted(!on);
    this.ui.setSound(on);
  }

  private setQuality(quality: Quality) {
    this.stage.quality = quality;
    store.set('quality', quality);
    this.ui.setQuality(quality);
    // The loop restarts in the new quality from its first frame, which is the still.
    if (!this.busy) void this.stage.show(this.place);
  }
}

const readList = (text: string | null): string[] => {
  try { const value = JSON.parse(text ?? '[]'); return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []; } catch { return []; }
};

/** 720p on phones and small windows, 2K elsewhere. */
function defaultQuality(): Quality {
  const shortSide = Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1);
  return window.innerWidth < 900 || shortSide < 1000 ? '720' : '2k';
}

async function boot() {
  const root = document.getElementById('app')!;
  let world: World;
  try {
    world = await loadWorld(worldUrl());
  } catch (error) {
    errorScreen(root, error instanceof Error ? error.message : String(error));
    return;
  }
  const player = new Player(root, world);
  await beginScreen(root, world, placeOf(world, world.start).still, () => player.unlockMedia());
  await player.begin();
}

void boot();
