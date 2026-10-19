import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, GIF_WIDTH, MEDIA_DIR, VIDEO, WORK_DIR } from './common.ts';
import type { Frame } from './web.ts';

/*
 * The demo frames (2x PNGs with per-frame durations) to a looping GIF for
 * the README, and to MP4 (H.264) and WebM (VP9) at the capture's CSS size.
 * Frame timing goes through ffmpeg's concat demuxer, then a constant frame
 * rate. The GIF uses one palette for the whole clip (palettegen with
 * stats_mode=diff weighs the pixels that change) and paletteuse's
 * rectangle diff mode, so each frame stores only the region that changed.
 */

const GIF_FPS = 15;
const VIDEO_FPS = 30;

async function concatList(frames: readonly Frame[]): Promise<string> {
  const lines = frames.flatMap((frame) => [`file '${frame.file.replaceAll("'", "'\\''")}'`, `duration ${frame.seconds.toFixed(4)}`]);
  // The concat demuxer applies the last duration only when the last file is listed again.
  const last = frames.at(-1);
  if (last) lines.push(`file '${last.file.replaceAll("'", "'\\''")}'`);
  const list = join(WORK_DIR, 'frames', 'concat.txt');
  await writeFile(list, `${lines.join('\n')}\n`);
  return list;
}

export async function encodeDemo(frames: readonly Frame[], name: string): Promise<string[]> {
  const list = await concatList(frames);
  const input = ['-f', 'concat', '-safe', '0', '-i', list];
  const gif = join(MEDIA_DIR, `${name}.gif`);
  const mp4 = join(MEDIA_DIR, `${name}.mp4`);
  const webm = join(MEDIA_DIR, `${name}.webm`);
  await ffmpeg([
    ...input,
    '-filter_complex',
    `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
    '-loop',
    '0',
    gif,
  ]);
  const scale = `fps=${VIDEO_FPS},scale=${VIDEO.width}:-2:flags=lanczos,format=yuv420p`;
  await ffmpeg([...input, '-vf', scale, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-tune', 'animation', '-movflags', '+faststart', '-an', mp4]);
  await ffmpeg([...input, '-vf', scale, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an', webm]);
  return [gif, mp4, webm];
}
