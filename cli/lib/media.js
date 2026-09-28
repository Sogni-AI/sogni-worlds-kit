// ffmpeg and ffprobe: the only outside tools the kit needs (the Sogni Creative
// Agent Skill needs them too). `node world doctor` says how to install them.
import { spawn, spawnSync } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function hasTool(command) {
  const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return result.status === 0;
}

/** Run a tool, resolve with its stdout; reject with the tail of stderr. */
export function run(command, args, { input, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let outBytes = 0;
    let err = '';
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > maxBuffer) child.kill('SIGKILL');
      else out.push(chunk);
    });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} failed (${code}): ${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const ffmpeg = args => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** Width, height, frame count, fps, seconds and audio channels of a video. */
export async function probe(path) {
  const out = await run(FFPROBE, ['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_type,width,height,nb_read_packets,r_frame_rate,channels:format=duration', '-of', 'json', path]);
  const data = JSON.parse(out.toString('utf8'));
  const video = data.streams?.find(stream => stream.codec_type === 'video');
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const [num, den] = String(video?.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    frames: Number(video?.nb_read_packets ?? 0),
    fps: den ? num / den : 0,
    seconds: Number(data.format?.duration ?? 0),
    audioChannels: audio?.channels ?? 0,
  };
}
