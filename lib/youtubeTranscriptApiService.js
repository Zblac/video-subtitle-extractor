/**
 * ============================================================================
 * youtubeTranscriptApiService —— 第三方 YouTube 字幕 API 适配层
 * 所属层：services（外部服务适配；不依赖 controller / route）。
 *
 * 用途：
 *   POST https://www.youtube-transcript.io/api/transcripts
 *   Authorization: Basic <YOUTUBE_TRANSCRIPT_API_TOKEN>
 *   body: { ids: [videoId] }
 *
 * 该接口返回的 tracks[].transcript 自带 start/dur，优先使用以保留时间轴；
 * 若只有纯文本 text，则复用 youtube.js 的 parseTranscriptText 兜底。
 * 输出形状与 youtubeTranscriptService 默认导出一致，交给 youtubeImportService
 * 继续走 importFromCues 的完整落库管线。
 * ============================================================================
 */
import { fetchWithTimeout, TRANSCRIPT_TIMEOUT_MS } from './fetch-timeout.js';
import { httpError } from './errors.js';
import { extractVideoId, parseTranscriptText } from './youtube.js';

const DEFAULT_API_URL = 'https://www.youtube-transcript.io/api/transcripts';

function readConfig() {
  return {
    url: String(process.env.YOUTUBE_TRANSCRIPT_API_URL || DEFAULT_API_URL).trim() || DEFAULT_API_URL,
    token: String(process.env.YOUTUBE_TRANSCRIPT_API_TOKEN || '').trim(),
  };
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLanguages(languages) {
  const list = Array.isArray(languages) ? languages : [];
  const normalized = list.map((x) => String(x || '').trim()).filter(Boolean);
  return normalized.length ? normalized : ['en'];
}

function cuesFromTrack(track) {
  const segments = Array.isArray(track?.transcript) ? track.transcript : [];
  const cues = [];
  for (const segment of segments) {
    const text = cleanText(segment?.text);
    if (!text) continue;
    const start = toFiniteNumber(segment?.start, cues.length ? cues[cues.length - 1].start + cues[cues.length - 1].duration : 0);
    const duration = toFiniteNumber(segment?.dur ?? segment?.duration, 0);
    cues.push({ text, start: start ?? 0, duration: Math.max(0, duration ?? 0) });
  }
  return cues;
}

function pickTrack(item, languages) {
  const tracks = Array.isArray(item?.tracks) ? item.tracks : [];
  const tracksWithTranscript = tracks.filter((t) => Array.isArray(t?.transcript) && t.transcript.length);
  if (!tracksWithTranscript.length) return null;

  const codes = languages.map((x) => x.toLowerCase());
  const byCode = tracksWithTranscript.find((t) => {
    const code = String(t?.languageCode || t?.code || '').toLowerCase();
    return code && codes.includes(code);
  });
  if (byCode) return byCode;

  const byName = tracksWithTranscript.find((t) => {
    const name = String(t?.language || '').toLowerCase();
    return codes.some((code) => {
      if (code === 'en') return name === 'english' || name === 'en';
      if (code === 'zh' || code === 'zh-cn') return name.includes('chinese') || name.includes('中文');
      return name.includes(code);
    });
  });
  return byName || tracksWithTranscript[0];
}

/**
 * 从 API 返回体里收集候选条目（兼容数组、{data:[...]}、{transcripts:[...]} 等）。
 * @param {any} value
 * @returns {object[]}
 */
function collectItems(value) {
  const items = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    const looksLikeItem =
      typeof node.text === 'string' ||
      Array.isArray(node.tracks) ||
      Array.isArray(node.transcript) ||
      Array.isArray(node.segments);
    if (looksLikeItem) {
      items.push(node);
      return;
    }

    for (const key of ['data', 'results', 'transcripts', 'items', 'videos']) {
      if (node[key]) visit(node[key], depth + 1);
    }
  };
  visit(value);
  return items;
}

function normalizeItem(item, videoId, languages) {
  const track = pickTrack(item, languages);
  let cues = track ? cuesFromTrack(track) : [];
  let rawText = '';

  if (!cues.length && typeof item?.text === 'string' && item.text.trim()) {
    try {
      cues = parseTranscriptText(item.text).map((c) => ({
        text: cleanText(c.text),
        start: toFiniteNumber(c.start, 0) ?? 0,
        duration: Math.max(0, (toFiniteNumber(c.end, 0) ?? 0) - (toFiniteNumber(c.start, 0) ?? 0)),
      })).filter((c) => c.text);
    } catch {
      cues = [];
    }
    rawText = item.text;
  }

  if (!cues.length) {
    throw httpError(404, '该视频没有可用字幕', 'EMPTY_TRANSCRIPT');
  }

  const language = String(track?.language || item?.languages?.languageCode || item?.language || languages[0] || '').trim();
  return {
    videoId: String(item?.id || videoId),
    title: String(item?.title || '').trim() || `YouTube:${videoId}`,
    language,
    isGenerated: Boolean(item?.isGenerated || track?.isGenerated),
    cues,
    rawText: rawText || cues.map((c) => c.text).join('\n'),
  };
}

/**
 * 拉取第三方字幕 API。
 * @param {object} opts
 * @param {string} [opts.url] YouTube 链接
 * @param {string} [opts.videoId] 11 位视频 id
 * @param {string[]} [opts.languages=['en']]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl] 测试注入
 * @returns {Promise<{videoId:string,title:string,language:string,isGenerated:boolean,cues:Array,rawText:string}>}
 */
export default async function fetchYouTubeTranscriptFromApi({
  url,
  videoId,
  languages = ['en'],
  timeoutMs = TRANSCRIPT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const id = videoId || extractVideoId(url);
  if (!id || !/^[\w-]{11}$/.test(String(id))) {
    throw httpError(400, '无法识别该 YouTube 链接，请粘贴有效的视频链接');
  }

  const { url: apiUrl, token } = readConfig();
  if (!token) {
    throw httpError(
      503,
      '服务器未配置 YouTube 字幕 API Token（YOUTUBE_TRANSCRIPT_API_TOKEN）',
      'YOUTUBE_API_NO_TOKEN'
    );
  }

  const res = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ ids: [id] }),
  }, timeoutMs, 'YouTube 字幕 API', fetchImpl);

  if (res.status === 401 || res.status === 403) {
    throw httpError(502, 'YouTube 字幕 API 鉴权失败，请检查 YOUTUBE_TRANSCRIPT_API_TOKEN', 'YOUTUBE_API_AUTH');
  }
  if (res.status === 429) {
    const retryAfter = res.headers?.get?.('retry-after');
    throw httpError(
      429,
      `YouTube 字幕 API 请求过于频繁${retryAfter ? `，请 ${retryAfter} 秒后重试` : '，请稍后重试'}`,
      'YOUTUBE_API_RATE_LIMIT'
    );
  }
  if (!res.ok) {
    throw httpError(502, `YouTube 字幕 API 返回 HTTP ${res.status}，请稍后重试`, 'YOUTUBE_API_HTTP');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw httpError(502, 'YouTube 字幕 API 返回了无法识别的数据', 'YOUTUBE_API_BAD_JSON');
  }

  const items = collectItems(data);
  if (!items.length) {
    throw httpError(502, 'YouTube 字幕 API 返回了无法识别的数据', 'YOUTUBE_API_BAD_SHAPE');
  }

  const item = items.find((x) => String(x?.id || '') === String(id)) || items[0];
  return normalizeItem(item, String(id), normalizeLanguages(languages));
}

export { collectItems, normalizeItem };
