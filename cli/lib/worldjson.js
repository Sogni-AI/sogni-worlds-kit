// world.json: the finished world the player reads. The formal description is
// schema/world.schema.json; this checks the same rules without a dependency,
// plus the ones a schema cannot say (a hotspot goes to a place that exists,
// ids are unique, the story order names real places).

export const FORMAT = 'sogni-world@1';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string' && value.length > 0;

function extra(object, allowed, where, issues) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) issues.push(`${where}: unknown field "${key}"`);
}

function film(value, where, issues, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (!isObject(value)) { issues.push(`${where}: must be an object with "src"`); return; }
  extra(value, ['src', 'src720', 'seconds'], where, issues);
  if (!isString(value.src)) issues.push(`${where}.src: required`);
  if (value.src720 !== undefined && !isString(value.src720)) issues.push(`${where}.src720: must be a path`);
  if (value.seconds !== undefined && !(typeof value.seconds === 'number' && value.seconds > 0)) issues.push(`${where}.seconds: must be a positive number`);
}

/** Every rule a world.json must meet; an empty list means it is playable. */
export function validateWorld(world) {
  const issues = [];
  if (!isObject(world)) return ['world.json must be an object'];
  extra(world, ['$schema', 'format', 'id', 'title', 'subtitle', 'credit', 'aspect', 'start', 'order', 'music', 'speakers', 'intro', 'map', 'draft', 'places'], 'world', issues);
  if (world.format !== FORMAT) issues.push(`format must be "${FORMAT}"`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(world.id ?? '')) issues.push('id: lower-case letters, digits and dashes');
  if (!isString(world.title)) issues.push('title: required');
  for (const key of ['subtitle', 'credit']) if (world[key] !== undefined && typeof world[key] !== 'string') issues.push(`${key}: must be text`);
  if (!isObject(world.aspect) || !Number.isInteger(world.aspect.width) || !Number.isInteger(world.aspect.height) || world.aspect.width < 1 || world.aspect.height < 1) {
    issues.push('aspect: { width, height } in whole pixels');
  } else extra(world.aspect, ['width', 'height'], 'aspect', issues);

  if (world.intro !== undefined) {
    if (!isObject(world.intro)) issues.push('intro: an object');
    else {
      extra(world.intro, ['eyebrow', 'tagline', 'warning', 'begin'], 'intro', issues);
      for (const [key, value] of Object.entries(world.intro)) if (typeof value !== 'string') issues.push(`intro.${key}: must be text`);
    }
  }
  for (const key of ['map', 'draft']) if (world[key] !== undefined && typeof world[key] !== 'boolean') issues.push(`${key}: true or false`);
  const places = Array.isArray(world.places) ? world.places : [];
  if (!places.length) issues.push('places: at least one place');
  const ids = new Set();
  for (const place of places) {
    if (isObject(place) && isString(place.id)) {
      if (ids.has(place.id)) issues.push(`places: "${place.id}" appears twice`);
      ids.add(place.id);
    }
  }
  if (!ids.has(world.start)) issues.push(`start: "${world.start}" is not a place`);
  if (world.order !== undefined && world.order !== null) {
    if (!Array.isArray(world.order)) issues.push('order: a list of place ids, or null');
    else for (const id of world.order) if (!ids.has(id)) issues.push(`order: "${id}" is not a place`);
  }
  const music = (value, where) => {
    if (value === undefined || value === null) return;
    if (!isObject(value)) { issues.push(`${where}: an object or null`); return; }
    extra(value, ['src', 'volume', 'underFilms', 'credit'], where, issues);
    if (!isString(value.src)) issues.push(`${where}.src: required`);
    if (value.volume !== undefined && !(value.volume >= 0 && value.volume <= 4)) issues.push(`${where}.volume: 0 to 4`);
    if (value.underFilms !== undefined && !(value.underFilms >= 0 && value.underFilms <= 1)) issues.push(`${where}.underFilms: 0 to 1`);
  };
  music(world.music, 'music');
  if (world.speakers !== undefined) {
    if (!isObject(world.speakers)) issues.push('speakers: an object keyed by name');
    else for (const [name, speaker] of Object.entries(world.speakers)) {
      if (!isObject(speaker)) issues.push(`speakers.${name}: an object`);
      else extra(speaker, ['avatar'], `speakers.${name}`, issues);
    }
  }

  for (const [index, place] of places.entries()) {
    const where = `places[${isObject(place) && place.id ? place.id : index}]`;
    if (!isObject(place)) { issues.push(`${where}: must be an object`); continue; }
    extra(place, ['id', 'title', 'chapter', 'caption', 'still', 'loop', 'narration', 'ending', 'music', 'hotspots'], where, issues);
    music(place.music, `${where}.music`);
    if (place.ending !== undefined && place.ending !== null) {
      if (!isObject(place.ending) || !['death', 'end'].includes(place.ending.kind) || !isString(place.ending.title)) issues.push(`${where}.ending: { kind: "death" | "end", title, text? }`);
      else {
        extra(place.ending, ['kind', 'title', 'text'], `${where}.ending`, issues);
        if (place.ending.text !== undefined && typeof place.ending.text !== 'string') issues.push(`${where}.ending.text: must be text`);
      }
    }
    if (!isString(place.id)) issues.push(`${where}.id: required`);
    if (!isString(place.title)) issues.push(`${where}.title: required`);
    if (!isString(place.still)) issues.push(`${where}.still: required`);
    for (const key of ['chapter', 'caption']) if (place[key] !== undefined && typeof place[key] !== 'string') issues.push(`${where}.${key}: must be text`);
    if (place.loop !== undefined) film(place.loop, `${where}.loop`, issues, { nullable: true });
    if (place.narration !== undefined && place.narration !== null) {
      const narration = place.narration;
      if (!isObject(narration)) issues.push(`${where}.narration: an object or null`);
      else {
        extra(narration, ['src', 'lines'], `${where}.narration`, issues);
        if (narration.src !== undefined && !isString(narration.src)) issues.push(`${where}.narration.src: must be a path`);
        if (!Array.isArray(narration.lines)) issues.push(`${where}.narration.lines: required`);
        else for (const [i, line] of narration.lines.entries()) {
          if (!isObject(line) || !isString(line.text)) { issues.push(`${where}.narration.lines[${i}]: needs text`); continue; }
          extra(line, ['text', 'speaker', 'start', 'end'], `${where}.narration.lines[${i}]`, issues);
          if ((line.start !== undefined || line.end !== undefined) && !(line.start >= 0 && line.end > line.start)) {
            issues.push(`${where}.narration.lines[${i}]: end must come after start`);
          }
        }
      }
    }
    if (!Array.isArray(place.hotspots)) { issues.push(`${where}.hotspots: required (may be empty)`); continue; }
    const hotspotIds = new Set();
    for (const [i, hotspot] of place.hotspots.entries()) {
      const at = `${where}.hotspots[${isObject(hotspot) && hotspot.id ? hotspot.id : i}]`;
      if (!isObject(hotspot)) { issues.push(`${at}: must be an object`); continue; }
      extra(hotspot, ['id', 'label', 'hint', 'at', 'outline', 'to', 'next', 'shortcut', 'collect', 'figure', 'film', 'rewind'], at, issues);
      if (!isString(hotspot.id)) issues.push(`${at}.id: required`);
      else if (hotspotIds.has(hotspot.id)) issues.push(`${at}: id appears twice in this place`);
      hotspotIds.add(hotspot.id);
      if (!isString(hotspot.label)) issues.push(`${at}.label: required`);
      if (hotspot.hint !== undefined && typeof hotspot.hint !== 'string') issues.push(`${at}.hint: must be text`);
      if (!Array.isArray(hotspot.at) || hotspot.at.length !== 2 || hotspot.at.some(v => typeof v !== 'number' || v < 0 || v > 1)) {
        issues.push(`${at}.at: [x, y] as fractions from 0 to 1`);
      }
      if (hotspot.outline !== undefined && hotspot.outline !== null) {
        const outline = hotspot.outline;
        if (!isObject(outline) || !(outline.width > 0) || !(outline.height > 0) || !isString(outline.path)) issues.push(`${at}.outline: { width, height, path }`);
        else extra(outline, ['width', 'height', 'path'], `${at}.outline`, issues);
      }
      if (hotspot.to !== undefined && hotspot.to !== null && !ids.has(hotspot.to)) issues.push(`${at}.to: "${hotspot.to}" is not a place`);
      for (const key of ['next', 'shortcut', 'collect']) if (hotspot[key] !== undefined && typeof hotspot[key] !== 'boolean') issues.push(`${at}.${key}: true or false`);
      if (hotspot.collect && hotspot.to) issues.push(`${at}: a collectible stays in its place (no "to")`);
      if (hotspot.figure !== undefined && hotspot.figure !== null) {
        const f = hotspot.figure;
        if (typeof f !== 'object' || typeof f.model !== 'string' || !f.model) issues.push(`${at}.figure: { model: "<file>.glb", icon?, name? }`);
        else for (const key of ['icon', 'name']) if (f[key] !== undefined && typeof f[key] !== 'string') issues.push(`${at}.figure.${key}: a string`);
      }
      if (hotspot.next && hotspot.shortcut) issues.push(`${at}: cannot be both the next stop and a shortcut`);
      // A collectible with a figure may have no film: it is picked up straight from the picture.
      if (hotspot.film !== undefined || !(hotspot.collect && hotspot.figure)) film(hotspot.film, `${at}.film`, issues);
      if (hotspot.rewind !== undefined) film(hotspot.rewind, `${at}.rewind`, issues, { nullable: true });
    }
  }
  return issues;
}

/** Every media path a world refers to (relative ones are files to ship with it). */
export function mediaRefs(world) {
  const refs = new Set();
  const add = value => { if (typeof value === 'string' && value) refs.add(value); };
  const addFilm = value => { if (value) { add(value.src); add(value.src720); } };
  add(world.music?.src);
  for (const speaker of Object.values(world.speakers ?? {})) add(speaker?.avatar);
  for (const place of world.places ?? []) {
    add(place.still);
    addFilm(place.loop);
    add(place.narration?.src);
    add(place.music?.src);
    for (const hotspot of place.hotspots ?? []) { addFilm(hotspot.film); addFilm(hotspot.rewind); add(hotspot.figure?.model); add(hotspot.figure?.icon); }
  }
  return [...refs];
}

export const isRemote = ref => /^[a-z]+:\/\//i.test(ref);
