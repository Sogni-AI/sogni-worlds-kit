import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpeg } from '../cli/lib/media.js';
import { finishFilm } from '../cli/lib/finish.js';
import { bitrateProfile, videoArgs, encodeFilm, filmIssues, measureFilm, imageIssues, audioIssues, deliveryIssues, strayPngs, writeIcon, writeServedStill } from '../cli/lib/delivery.js';
import { tempDir, syntheticVideo } from './helpers.js';

test('the streaming profile: CRF 23, the cap by short edge with a buffer of twice it, a keyframe every 2 s, fast start', () => {
  assert.equal(bitrateProfile(1152, 768).maxrate, 4_500_000);
  assert.equal(bitrateProfile(768, 1344).maxrate, 4_500_000, 'the short edge decides, in either orientation');
  assert.equal(bitrateProfile(1920, 1080).maxrate, 8_000_000);
  assert.deepEqual(bitrateProfile(2304, 1536), { name: '2K', maxrate: 12_000_000, bufsize: 24_000_000 });
  const args = videoArgs({ width: 2304, height: 1536, fps: 24 }).join(' ');
  for (const part of ['-c:v libx264', '-preset slow', '-crf 23', '-maxrate 12000000', '-bufsize 24000000', '-g 48', '-pix_fmt yuv420p', '-movflags +faststart']) {
    assert.ok(args.includes(part), part);
  }
  assert.ok(videoArgs({ width: 1344, height: 768, fps: 30 }).join(' ').includes('-g 60'), 'two seconds at the film\'s own rate');
});

test('a film encoded without the profile fails, and says why; the finished one passes', async () => {
  const dir = tempDir('delivery-film');
  const take = join(dir, 'take.mp4');
  await syntheticVideo(take, { source: 'testsrc2=size=SIZE:rate=24', seconds: 5 });
  // Lossless noise, one keyframe, the index at the end: what an uncapped encode looks like (about 26 Mbps, far more
  // than three seconds at the 4.5 Mbps cap plus its 9 Mbit buffer can carry).
  const raw = join(dir, 'raw.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'nullsrc=s=384x256:r=24,geq=random(1)*255:128:128', '-t', '3', '-c:v', 'libx264', '-qp', '0', '-g', '250', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', raw]);
  const issues = await filmIssues(raw, 'raw.mp4');
  assert.ok(issues.some(i => /fast start/.test(i)), 'no fast start');
  assert.ok(issues.some(i => /between keyframes/.test(i)), 'GOP over 2 s');
  assert.ok(issues.some(i => /carries more than the 4\.5 Mbps cap and its 9 Mbit buffer allow .* averages/.test(i)), 'more than the cap and its buffer');

  const main = join(dir, 'main.mp4'), half = join(dir, 'half.mp4');
  await finishFilm(take, main, half);
  assert.deepEqual(await filmIssues(main, 'main.mp4'), []);
  assert.deepEqual(await filmIssues(half, 'half.mp4'), []);
});

test('a film under the cap on average that bursts past it still fails', async () => {
  const dir = tempDir('delivery-burst');
  const film = join(dir, 'burst.mp4');
  // Twenty quiet seconds and one of lossless noise: about 3 Mbps on average, 60 Mbit in that second.
  await ffmpeg(['-f', 'lavfi', '-i', "color=c=gray:s=640x360:r=24:d=20,noise=alls=100:allf=t+u:enable='between(t,10,11)'", '-c:v', 'libx264', '-qp', '0', '-g', '48',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', film]);
  const issues = await filmIssues(film, 'burst.mp4');
  assert.equal(issues.length, 1, issues.join('; '));
  assert.match(issues[0], /carries more than the 4\.5 Mbps cap and its 9 Mbit buffer allow .* busiest second carries .*: it was encoded without the cap/);
});

// Reported 2026-10-26: 37 of 54 films a creator's Kit had encoded itself (8 to 9.5 s of fountains, surf, drone moves)
// failed build's check at 12.6 to 13.6 Mbps (2K) and 4.7 to 5.0 Mbps (768p), against a check of the average at the cap
// plus 5%. x264 starts its buffer 90% full and may spend it on top of the cap, so a short, busy film averages over it.
test('a short, busy film the Kit encodes passes the Kit\'s own check though it averages over its cap; uncapped, it fails', async () => {
  const dir = tempDir('delivery-busy');
  for (const [width, height, seconds] of [[1344, 768, 8.7], [2688, 1536, 4]]) {
    const master = join(dir, `master-${height}.mkv`), film = join(dir, `film-${height}.mp4`), uncapped = join(dir, `uncapped-${height}.mp4`);
    // Grain moving over every pixel: harder for x264 than any fountain. The master is compressed to keep the test
    // small (encodeFilm only decodes it); it is still far busier than the cap allows.
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=24,noise=alls=60:allf=t+u`, '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', master]);
    const { maxrate } = bitrateProfile(width, height);
    await encodeFilm(master, film, { width, height, fps: 24 });
    const measured = await measureFilm(film);
    assert.ok(measured.averageBps > maxrate * 1.05, `${width}×${height}: averages ${(measured.averageBps / 1e6).toFixed(2)} Mbps, over the cap + 5% the old check allowed`);
    assert.deepEqual(await filmIssues(film, `film-${height}.mp4`), [], `${width}×${height}: the Kit's own encode passes`);
    // The same clip through the same profile without its cap.
    const args = videoArgs({ width, height, fps: 24 });
    const withoutCap = args.filter((arg, i) => !['-maxrate', '-bufsize'].includes(arg) && !['-maxrate', '-bufsize'].includes(args[i - 1]));
    await ffmpeg(['-i', master, ...withoutCap, '-an', uncapped]);
    rmSync(master);
    const issues = await filmIssues(uncapped, `uncapped-${height}.mp4`);
    assert.equal(issues.length, 1, issues.join('; '));
    assert.match(issues[0], /carries more than the .* cap and its .* buffer allow .*: it was encoded without the cap/);
  }
});

test('stills ship as WebP, PNG only for icons of 512 px or less, sound compressed, nothing carrying camera metadata', async () => {
  const dir = tempDir('delivery-images');
  const picture = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#335577' } });
  await picture(192, 128).png().toFile(join(dir, 'still.png'));
  await picture(192, 128).jpeg().toFile(join(dir, 'still.jpg'));
  await picture(192, 128).webp().toFile(join(dir, 'still.webp'));
  await picture(192, 128).withExif({ IFD0: { Make: 'Camera' } }).webp().toFile(join(dir, 'exif.webp'));
  await picture(320, 320).png().toFile(join(dir, 'icon.png'));
  await picture(600, 600).png().toFile(join(dir, 'big-icon.png'));
  assert.match((await imageIssues(join(dir, 'still.png'), 'still.png'))[0], /is PNG; stills ship as WebP/);
  assert.match((await imageIssues(join(dir, 'still.jpg'), 'still.jpg'))[0], /is JPEG; stills ship as WebP/);
  assert.deepEqual(await imageIssues(join(dir, 'still.webp'), 'still.webp'), []);
  assert.match((await imageIssues(join(dir, 'exif.webp'), 'exif.webp'))[0], /camera metadata/);
  assert.deepEqual(await imageIssues(join(dir, 'icon.png'), 'icon.png', { icon: true }), []);
  assert.match((await imageIssues(join(dir, 'big-icon.png'), 'big-icon.png', { icon: true }))[0], /PNG is for icons of 512 px or less/);
  // What build writes: a still at its own size, an icon that keeps its transparency.
  await writeServedStill(join(dir, 'still.png'), join(dir, 'served.webp'));
  const served = await sharp(join(dir, 'served.webp')).metadata();
  assert.deepEqual([served.format, served.width, served.height], ['webp', 192, 128]);
  await sharp({ create: { width: 640, height: 480, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0 } } }).png().toFile(join(dir, 'cutout.png'));
  await writeIcon(join(dir, 'cutout.png'), join(dir, 'icon.webp'));
  const icon = await sharp(join(dir, 'icon.webp')).metadata();
  assert.deepEqual([icon.format, icon.width, icon.height, icon.hasAlpha], ['webp', 320, 240, true]);
  assert.deepEqual(await imageIssues(join(dir, 'icon.webp'), 'icon.webp', { icon: true }), []);

  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:sample_rate=24000', '-t', '1', join(dir, 'music.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:sample_rate=24000', '-t', '1', join(dir, 'music.mp3')]);
  assert.match((await audioIssues(join(dir, 'music.wav'), 'music.wav'))[0], /uncompressed/);
  assert.deepEqual(await audioIssues(join(dir, 'music.mp3'), 'music.mp3'), []);
});

test('a world is checked file by file; remote media is counted, a served PNG that is no icon is named', async () => {
  const dir = tempDir('delivery-world');
  mkdirSync(join(dir, 'stills'), { recursive: true });
  mkdirSync(join(dir, 'figures'), { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 4, background: '#0000' } }).png().toFile(join(dir, 'figures', 'lotus.png'));
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).png().toFile(join(dir, 'stills', 'a.png'));
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).png().toFile(join(dir, 'leftover.png'));
  writeFileSync(join(dir, 'figures', 'lotus.glb'), 'glb');
  const world = { places: [
    { id: 'a', still: 'stills/a.png', hotspots: [{ id: 'lotus', figure: { model: 'figures/lotus.glb', icon: 'figures/lotus.png' } }] },
    { id: 'b', still: 'https://cdn.example/b.png', hotspots: [] },
  ] };
  const { issues, remote } = await deliveryIssues(world, dir);
  assert.deepEqual(issues, ['stills/a.png (places[a].still): is PNG; stills ship as WebP']);
  assert.deepEqual(remote, { count: 1, png: ['https://cdn.example/b.png'] });
  assert.deepEqual(strayPngs(world, dir), ['leftover.png: a PNG that is not an icon; served pictures ship as WebP', 'stills/a.png: a PNG that is not an icon; served pictures ship as WebP']);
});
