/**
 * ytsub —— 粘贴视频链接，一条命令拿到字幕。
 *
 * 流程：
 *   1) 解析链接（YouTube 走原项目的第三方字幕 API 链路；其他站点用 yt-dlp 探测）
 *   2) 取官方字幕：YouTube → youtube-transcript.io API；其他站点 → yt-dlp 抓平台字幕
 *   3) 下载视频到 out/<id>/
 *   4) 本地 faster-whisper 转录（GPU 优先，失败退回 CPU）
 *   5) 统一切成句子级 cue，写出 srt / vtt / txt / json
 *
 * 用法：node ytsub.js <链接> [选项]
 *   --out <dir>        输出根目录（默认 ./out）
 *   --model <name>     whisper 模型（默认 small；可选 base/small/medium/large-v3）
 *   --device <auto|cpu|cuda>
 *   --compute <auto|int8|float16>
 *   --proxy <url>      yt-dlp 用的代理
 *   --no-api           不调用第三方字幕 API，只做本地转录
 *   --no-download      不下载视频（需要已有 media.*）
 *   --no-asr           不做本地转录
 *   --audio-only       只下音频
 *   --cookies <browser>  yt-dlp 从浏览器取 cookie（如 chrome）
 *   --print-text       把字幕正文打到 stdout
 */
import fs from 'node:fs';
import path from 'node:path';

import { config, scrub, ROOT } from './lib/config.js';
import { extractVideoId } from './lib/youtube.js';
import fetchYouTubeTranscriptFromApi from './lib/youtubeTranscriptApiService.js';
import { segmentYouTubeCues } from './lib/youtubeSentenceSegmenter.js';
import { parseSubtitle } from './lib/subtitleParser.js';
import { download, extractWav, findMedia, readInfo, runGrabSubs } from './lib/ytdlp.js';
import { writeAll, durationOf, toTxt } from './lib/formats.js';

const isYouTubeUrl = (u) => /(^|\.)(youtu\.be|youtube\.com|youtube-nocookie\.com)\//i.test(u);

function parseArgs(argv) {
  const out = { _: [] };
  const flags = {
    '--out': 'out', '--model': 'model', '--device': 'device', '--compute': 'compute',
    '--proxy': 'proxy', '--cookies': 'cookies', '--lang': 'lang',
    '--no-api': 'noApi', '--no-download': 'noDownload',
    '--no-asr': 'noAsr', '--force-asr': 'forceAsr', '--audio-only': 'audioOnly', '--print-text': 'printText', '--download-only': 'downloadOnly',
    '--json': 'json', '--media': 'media',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (flags[a]) out[flags[a]] = true;
    else if (a.startsWith('--') && flags[a.split('=')[0]]) {
      const [k, v] = a.split('=');
      out[flags[k]] = v;
    } else if (a.startsWith('--') && flags[a]) out[flags[a]] = true;
    else if (argv[i - 1]?.startsWith('--') && flags[argv[i - 1]]) out[flags[argv[i - 1]]] = a;
    else if (!a.startsWith('--')) out._.push(a);
  }
  return out;
}

let jsonMode = false;

function log(msg) {
  // --json 模式下把过程日志全部走 stderr，stdout 只留最后一行的结构化结果
  (jsonMode ? console.error : console.log)(msg);
}

/** 把平台原始字幕（srt/vtt）读成 cues。 */
function cuesFromSubtitleFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return parseSubtitle(raw).map((c) => ({
    text: String(c.text || '').trim(),
    start: Number(c.start) || 0,
    duration: Math.max(0, (Number(c.end) || 0) - (Number(c.start) || 0)),
  })).filter((c) => c.text);
}

/** out/.index.json：链接 → 视频 id，用于二次运行直接复用已下载的媒体。 */
function readIndex(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeIndex(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 索引只是加速，写失败不影响主流程 */ }
}

/** 把 pending 目录的内容挪到最终 id 目录，返回最终目录里的媒体文件。 */
function adoptDir(fromDir, toDir) {
  if (path.resolve(fromDir) !== path.resolve(toDir)) {
    if (!fs.existsSync(toDir)) {
      fs.renameSync(fromDir, toDir);
    } else {
      for (const f of fs.readdirSync(fromDir)) {
        const src = path.join(fromDir, f);
        const dst = path.join(toDir, f);
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      }
      fs.rmSync(fromDir, { recursive: true, force: true });
    }
  }
  return findMedia(toDir);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  jsonMode = Boolean(a.json);
  const url = a._[0];
  // --media：直接对本地媒体做转录（抖音这类只能先在浏览器里拿到直链、由 python/media.py 下载的场景）
  const localMedia = a.media ? path.resolve(String(a.media)) : null;
  if (!url && !localMedia) {
    console.error('用法：node ytsub.js <视频链接> [选项]   或   node ytsub.js --media <本地媒体> [选项]');
    return 2;
  }
  const cfg = config({ outDir: a.out, model: a.model, device: a.device, computeType: a.compute });
  const tag = a.lang;
  const t0 = Date.now();
  const timings = {};
  const mark = (name, since) => {
    timings[name] = Number(((Date.now() - since) / 1000).toFixed(1));
  };
  const until = (key) => timings[key] ?? 0;

  // 1) 解析来源：YouTube 直接从链接取 id；其他站点不单独探测，下载后从 info 里取真实 id
  const ytId = isYouTubeUrl(url || '') ? extractVideoId(url) : null;
  // 国内站点走代理反而容易被限制/变慢，默认只给 YouTube 用代理
  const proxy = a.proxy ?? (ytId ? cfg.proxy : '');
  const source = ytId ? 'youtube' : 'other';
  const indexPath = path.join(cfg.outDir, '.index.json');
  const index = readIndex(indexPath);
  const cachedEntry = index[url] || null;
  let id = ytId || (cachedEntry?.id || '') || (localMedia ? path.basename(path.dirname(localMedia)) : '');
  let title = cachedEntry?.title || '';
  let dir = localMedia
    ? path.dirname(localMedia)
    : path.join(cfg.outDir, (id || `.pending-${process.pid}-${Date.now()}`).replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const report = { url: url || null, id, title, source: localMedia ? 'local-media' : (ytId ? 'youtube' : 'other'), startedAt: new Date().toISOString(), stages: {}, timings };
  const warnings = [];

  // 2) 官方字幕
  let apiCues = null;
  if (ytId && !a.noApi) {
    if (!cfg.token) {
      warnings.push('未配置 YOUTUBE_TRANSCRIPT_API_TOKEN，跳过第三方字幕 API');
      log('· 未配置字幕 API Token，跳过官方字幕');
    } else {
      log('· 拉取 YouTube 官方/自动字幕（youtube-transcript.io）...');
      try {
        const r = await fetchYouTubeTranscriptFromApi({ videoId: ytId, languages: tag ? [tag] : ['en', 'zh'] });
        title = title || r.title;
        apiCues = segmentYouTubeCues(r.cues);
        const files = writeAll(dir, 'api', apiCues, { source: 'api', videoId: ytId, title, language: r.language, generated: r.isGenerated });
        report.stages.api = { ok: true, count: apiCues.length, language: r.language, generated: r.isGenerated, duration: durationOf(apiCues), files };
        log(`  官方字幕 ${apiCues.length} 句 / ${durationOf(apiCues).toFixed(0)}s（语言 ${r.language || '?'}${r.isGenerated ? '，自动生成' : ''}）`);
      } catch (e) {
        const msg = scrub(e.message || e, cfg.token);
        report.stages.api = { ok: false, code: e.code, error: msg };
        warnings.push(`官方字幕不可用：${msg}`);
        log(`  官方字幕不可用：${msg}`);
      }
    }
  }

  // 3) 下载
  let media = localMedia || findMedia(dir);
  if (!a.noDownload && !media) {
    log('· 下载视频（yt-dlp）...');
    const tDown = Date.now();
    try {
      await download({
        url: ytId ? `https://www.youtube.com/watch?v=${ytId}` : url,
        dir, python: cfg.python, proxy, audioOnly: a.audioOnly,
        cookiesFromBrowser: a.cookies, onLine: (l) => { if (/Destination|download|ETA|\[/.test(l)) log(`  ${l}`); },
      });
      const info = readInfo(dir);
      if (!title && info.title) title = info.title;
      // 非 YouTube：真实 id 只有下载完才知道，把 pending 目录改名为 id 目录
      if (!ytId && info.id) {
        id = String(info.id);
        const finalDir = path.join(cfg.outDir, id.replace(/[^\w.-]/g, '_'));
        media = adoptDir(dir, finalDir);
        dir = finalDir;
      } else {
        media = findMedia(dir);
      }
      index[url] = { id, title: title || null, dir };
      writeIndex(indexPath, index);
      report.id = id;
      report.title = title;
      mark('download', tDown);
      if (media) {
        report.stages.download = { ok: true, file: media, bytes: fs.statSync(media).size };
        log(`  ${path.basename(media)}  ${(fs.statSync(media).size / 1048576).toFixed(1)} MB（${until('download')}s）`);
      }
    } catch (e) {
      report.stages.download = { ok: false, error: e.message };
      warnings.push(`下载失败：${e.message}`);
      log(`  下载失败：${e.message}`);
    }
  } else if (media) {
    report.stages.download = { ok: true, file: media, reused: true };
    log(`· 复用已有媒体 ${path.basename(media)}`);
  }

  // 3.5) 非 YouTube：尝试平台自带字幕（B 站字幕接口要登录，只有给了 cookie 才有意义，
  //      没给就跳过，省掉一次 yt-dlp 启动）
  if (!ytId && !a.noApi && a.cookies) {
    log('· 尝试平台自带字幕文件...');
    try {
      const subs = await runGrabSubs({ url, dir, python: cfg.python, proxy, cookiesFromBrowser: a.cookies });
      if (subs.length) {
        const cues = cuesFromSubtitleFile(subs[0]).map((c) => ({ ...c }));
        const seg = segmentYouTubeCues(cues);
        if (seg.length) {
          apiCues = seg;
          const files = writeAll(dir, 'api', seg, { source: 'platform', videoId: id, title });
          report.stages.api = { ok: true, count: seg.length, language: 'platform', duration: durationOf(seg), files };
          log(`  平台字幕 ${seg.length} 句（${path.basename(subs[0])}）`);
        }
      } else {
        log('  平台没有可直接下载的字幕');
      }
    } catch (e) {
      log(`  平台字幕抓取失败：${e.message}`);
    }
  }

  // 4) 本地转录：已经有官方/平台字幕就不再转录（省掉最贵的这一步）
  let asrCues = null;
  if (!a.noAsr && !a.downloadOnly && (!apiCues || a.forceAsr)) {
    if (!media) {
      warnings.push('没有媒体文件，无法本地转录');
    } else {
      const outJson = path.join(dir, 'asr_raw.json');
      const runOnce = (input) => spawnPy(input, outJson, cfg, tag, a, log);
      const tAsr = Date.now();
      try {
        log(`· 本地转录（faster-whisper ${cfg.model}）...`);
        await runOnce(media);
        const raw = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        asrCues = segmentYouTubeCues(raw.segments.map((s) => ({
          text: s.text, start: s.start, duration: Math.max(0, (s.end || 0) - (s.start || 0)),
        })));
        mark('asr', tAsr);
        timings.asrCompute = raw.elapsed;
        const files = writeAll(dir, 'asr', asrCues, { source: 'whisper', model: raw.model, device: raw.device, language: raw.language, videoId: id, title });
        report.stages.asr = {
          ok: true, count: asrCues.length, language: raw.language,
          languageProbability: raw.language_probability, device: raw.device, compute: raw.compute_type,
          elapsed: raw.elapsed, duration: durationOf(asrCues), files,
        };
        log(`  转录 ${asrCues.length} 句，耗时 ${raw.elapsed}s（${raw.device}/${raw.compute_type}，语言 ${raw.language}）`);
      } catch (e) {
        const wav = path.join(dir, 'audio16k.wav');
        log(`  直接解码失败（${e.message.slice(0, 120)}），改用 ffmpeg 抽 wav 重试`);
        try {
          await extractWav({ input: media, output: wav, ffmpeg: cfg.ffmpeg });
          await runOnce(wav);
          const raw = JSON.parse(fs.readFileSync(outJson, 'utf8'));
          asrCues = segmentYouTubeCues(raw.segments.map((s) => ({
            text: s.text, start: s.start, duration: Math.max(0, (s.end || 0) - (s.start || 0)),
          })));
          const files = writeAll(dir, 'asr', asrCues, { source: 'whisper', model: raw.model, device: raw.device, language: raw.language, videoId: id, title });
          report.stages.asr = { ok: true, count: asrCues.length, language: raw.language, device: raw.device, elapsed: raw.elapsed, files };
          log(`  转录 ${asrCues.length} 句（wav 路径），耗时 ${raw.elapsed}s`);
        } catch (e2) {
          report.stages.asr = { ok: false, error: e2.message };
          warnings.push(`本地转录失败：${e2.message}`);
          log(`  本地转录失败：${e2.message}`);
        }
      }
    }
  }

  // 5) 主字幕：官方优先，缺失时用转录
  const primary = apiCues || asrCues;
  if (primary && primary.length) {
    const files = writeAll(dir, 'subtitles', primary, {
      source: apiCues ? 'official' : 'whisper', videoId: id, title, url,
    });
    report.final = { source: apiCues ? 'official' : 'whisper', count: primary.length, duration: durationOf(primary), dir, files };
  }

  report.title = title;
  report.warnings = warnings;
  timings.total = Number(((Date.now() - t0) / 1000).toFixed(1));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  log('');
  log(`输出目录：${dir}`);
  if (report.final) {
    log(`字幕：${report.final.count} 句 / ${report.final.duration.toFixed(0)}s  来源 ${report.final.source === 'official' ? '官方字幕' : '本地转录'}`);
  } else {
    log('未产出任何字幕');
  }
  const parts = [];
  if (timings.download) parts.push(`下载 ${timings.download}s`);
  if (timings.asr) parts.push(`转录 ${timings.asr}s${timings.asrCompute ? `（其中推理 ${timings.asrCompute}s）` : ''}`);
  parts.push(`合计 ${timings.total}s`);
  log(`耗时：${parts.join(' / ')}`);

  if (a.printText && primary) process.stdout.write(toTxt(primary));
  if (jsonMode) console.log(JSON.stringify(report));
  return report.final ? 0 : 1;
}

/** 启动 python 转录进程（用 spawn 保留 stderr 进度）。 */
function spawnPy(input, outJson, cfg, lang, a, logFn) {
  return new Promise((resolve, reject) => {
    const argsPath = path.join(ROOT, 'python', 'transcribe.py');
    const args = [argsPath, '--media', input, '--out', outJson, '--model', cfg.model,
      '--model-dir', cfg.modelDir, '--device', cfg.device, '--compute', cfg.computeType];
    if (lang) args.push('--language', lang);
    // 延迟 import，保持文件顶部依赖清晰
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(cfg.python, args, { windowsHide: true });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        err += c;
        for (const line of String(c).split(/\r?\n/)) if (line.includes('[whisper]')) logFn(`  ${line.replace('[whisper] ', '')}`);
      });
      child.on('error', (e) => reject(new Error(`无法启动 python：${e.message}`)));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outJson)) resolve();
        else reject(new Error(err.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || `python 退出码 ${code}`));
      });
    }, reject);
  });
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});
