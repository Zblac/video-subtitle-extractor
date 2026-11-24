/**
 * YouTube 导入：仅通过 YouTube Transcript API 获取字幕文件
 * - 粘贴链接 → 只取字幕 → 直接进入文本操作台（不需要播放视频）。
 * - 无视频播放链路：字幕仅供学习展示，不缓存视频。
 * - 若未配置 Token，会给出明确的中文提示。
 */
import { parseSubtitle } from './subtitleParser.js';
import { fetchWithTimeout, TRANSCRIPT_TIMEOUT_MS } from './fetch-timeout.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function extractVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.replace(/^\/\//, 'https://'));
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
    if (u.hostname.endsWith('youtube.com') || u.hostname.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => ['embed', 'shorts', 'live', 'v'].includes(p));
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].slice(0, 11);
    }
  } catch {
    /* fall through */
  }
  const m = s.match(/([\w-]{11})/);
  return m ? m[1] : null;
}

/* ---------------- YouTube Transcript API ---------------- */

function transcriptConfig() {
  return {
    url: process.env.YOUTUBE_TRANSCRIPT_API_URL || 'https://www.youtube-transcript.io/api/transcripts',
    token: process.env.YOUTUBE_TRANSCRIPT_API_TOKEN || '',
  };
}

/**
 * 调用 youtube-transcript.io API 下载字幕。返回 { id, title, text }
 * API 格式：POST https://www.youtube-transcript.io/api/transcripts
 *   headers: { Authorization: Basic <token>, Content-Type: application/json }
 *   body:    { "ids": ["<videoId>"] }
 */
async function fetchTranscriptViaApi(videoId) {
  const { url, token } = transcriptConfig();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + token,
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
    },
    body: JSON.stringify({ ids: [videoId] }),
  }, TRANSCRIPT_TIMEOUT_MS, '字幕服务');
  if (!res.ok) {
    throw new Error(`字幕服务返回 HTTP ${res.status}，可改用手动上传字幕`);
  }
  const data = await res.json();
  if (Array.isArray(data) && data[0]) {
    const item = data[0];
    if (!(item.text || '').trim()) throw new Error('该视频暂无可用字幕（可能没有字幕轨道）。');
    return { id: item.id || videoId, title: item.title || videoId, text: item.text };
  }
  throw new Error('字幕服务返回了无法识别的数据。');
}

/**
 * 把 transcript API 返回的纯文本字幕解析为 cues。
 * 兼容：SRT/VTT 时间行、单时间戳行、纯文本行。
 */
export function parseTranscriptText(text) {
  const raw = (text || '').trim();
  if (!raw) throw new Error('字幕内容为空');
  // 带 SRT/VTT 时间行 → 走标准解析
  if (/(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})/.test(raw)) {
    return parseSubtitle(raw);
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let idx = 0;
  let clock = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 行首时间戳：00:00:01.234 或 00:01.234 或 01.234 后接正文
    const tm = trimmed.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?[:\s]\s*(.*)$/i);
    let body = trimmed;
    let start = null;
    if (tm && tm[5] && tm[5].trim()) {
      const h = tm[1] ? parseInt(tm[1], 10) : 0;
      const m = parseInt(tm[2], 10);
      const s = parseInt(tm[3], 10);
      const ms = tm[4] ? parseInt(tm[4].padEnd(3, '0').slice(0, 3), 10) : 0;
      start = h * 3600 + m * 60 + s + ms / 1000;
      body = tm[5].trim();
    }
    body = body
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    if (start === null) start = clock;
    const dur = Math.max(1.2, (body.length / 15) * 1.0);
    cues.push({ index: idx++, start: Math.round(start * 1000) / 1000, end: Math.round((start + dur) * 1000) / 1000, text: body });
    clock = start + dur;
  }
  if (!cues.length) throw new Error('未能从字幕中解析到任何句子');
  return cues;
}

/**
 * 解析一个 YouTube 链接（仅通过 Transcript API 取字幕，用于文本操作台）
 * 返回 { videoId, title, author, duration, thumbnail, tracks, cues, selectedLang, transcriptText, transcriptApi }
 * 失败：抛错（message 面向用户）。
 */
export async function importYouTube(rawUrl, { lang = 'en' } = {}) {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    const e = new Error('无法识别该链接，请粘贴有效的 YouTube 视频链接');
    e.code = 'BAD_URL';
    throw e;
  }

  const cfg = transcriptConfig();
  if (!cfg.token) {
    const e = new Error('尚未配置 YouTube 字幕 API Token：请在项目根目录 .env 中填写 YOUTUBE_TRANSCRIPT_API_TOKEN 后再导入。');
    e.code = 'NO_TOKEN';
    throw e;
  }

  const tr = await fetchTranscriptViaApi(videoId);
  const cues = parseTranscriptText(tr.text);
  return {
    videoId,
    title: tr.title || 'YouTube 视频',
    author: '',
    duration: cues.at(-1)?.end || 0,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    tracks: [],
    cues,
    selectedLang: lang,
    transcriptText: tr.text,
    transcriptApi: true,
  };
}
