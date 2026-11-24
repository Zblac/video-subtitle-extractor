/**
 * yt-dlp 下载封装：把视频落到 <out>/<videoId>/media.<ext>，并读取 info.json。
 * 只调用本机 python -m yt_dlp，不引入 npm 依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const pump = (stream, sink) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        sink(chunk);
        if (onLine) {
          for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine(line.trim());
        }
      });
    };
    pump(child.stdout, (c) => { stdout += c; });
    pump(child.stderr, (c) => { stderr += c; });
    child.on('error', (e) => reject(new Error(`无法启动 ${cmd}：${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} 退出码 ${code}\n${stderr.slice(-1200)}`), { stderr }));
    });
  });
}

/** 找到目录里的媒体文件（media.* 排除 info.json / part）。 */
export function findMedia(dir) {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir)
    .filter((f) => f.startsWith('media.'))
    .filter((f) => !/\.(json|part|ytdl|temp)$/i.test(f))
    .map((f) => path.join(dir, f));
  return hit[0] || null;
}

export function readInfo(dir) {
  const p = path.join(dir, 'media.info.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

/**
 * @param {object} o
 * @param {string} o.url 视频页地址（YouTube 用 watch?v=id，其他站点用原始链接）
 * @param {string} o.dir 输出目录
 * @param {string} o.python
 * @param {string} [o.proxy]
 * @param {boolean} [o.audioOnly]
 * @param {string} [o.cookiesFromBrowser] 如 chrome / edge
 * @param {(line:string)=>void} [o.onLine]
 */
export async function download(o) {
  const { url, dir, python, proxy, audioOnly, cookiesFromBrowser, onLine } = o;
  fs.mkdirSync(dir, { recursive: true });
  const existing = findMedia(dir);
  if (existing) return { file: existing, skipped: true };

  const args = [
    '-m', 'yt_dlp',
    '--no-playlist',
    '--no-part',
    '--write-info-json',
    '--newline',
    '-o', path.join(dir, 'media.%(ext)s'),
  ];
  if (audioOnly) {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'm4a');
  } else {
    args.push('-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b');
    args.push('--merge-output-format', 'mp4');
  }
  if (proxy) args.push('--proxy', proxy);
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  args.push(url);

  await run(python, args, { onLine });
  const file = findMedia(dir);
  if (!file) throw new Error('下载完成但没找到媒体文件');
  return { file, skipped: false };
}

/** 只探测元信息，不下载：{ id, title, duration, extractor }。 */
export async function probe({ url, python, proxy }) {
  const args = ['-m', 'yt_dlp', '--no-playlist', '--skip-download', '--no-warnings',
    '--print', '%(id)s\t%(title)s\t%(duration)s\t%(extractor)s'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const { stdout } = await run(python, args);
  const [id, title, duration, extractor] = stdout.trim().split('\t');
  return { id, title, duration: Number(duration) || null, extractor };
}

/** 抓平台自带字幕（b 站等需要登录时才需要 --cookies）。返回本地 srt/vtt 路径列表。 */
export async function runGrabSubs({ url, dir, python, proxy, cookiesFromBrowser }) {
  const args = ['-m', 'yt_dlp', '--no-playlist', '--skip-download', '--no-warnings',
    '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-CN,zh,zh-TW,en,en-orig',
    '--convert-subs', 'srt', '--sub-format', 'srt/vtt/best',
    '-o', path.join(dir, 'sub.%(ext)s')];
  if (proxy) args.push('--proxy', proxy);
  if (cookiesFromBrowser) args.push('--cookies-from-browser', cookiesFromBrowser);
  args.push(url);
  try { await run(python, args); } catch { /* 没有字幕不算失败 */ }
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^sub\..*\.(srt|vtt)$/i.test(f)).map((f) => path.join(dir, f))
    : [];
}

/** 抽 16kHz 单声道 wav 给 Whisper（ffmpeg 缺失时由调用方报错）。 */
export async function extractWav({ input, output, ffmpeg }) {
  await run(ffmpeg, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', output]);
  if (!fs.existsSync(output)) throw new Error('音频抽取失败，未生成 wav');
  return output;
}

export { run };
