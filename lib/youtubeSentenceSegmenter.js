/**
 * ============================================================================
 * youtubeSentenceSegmenter —— YouTube 自动字幕的句子级切分
 *
 * 背景：第三方字幕 API 的 tracks[].transcript 是「字幕显示片段」，不是自然句。
 * 自动字幕经常是 3~8 个词的碎片，且没有句末标点；如果直接 1:1 落库，
 * 阅读页会变成大量碎片，播放弹窗里一条长句也会挤成多行。
 *
 * 本模块只做纯文本 + 时间轴处理，不访问网络 / 数据库：
 *   1. 同一 cue 内有多句时，按句末标点切开，并按字符比例分配时间；
 *   2. 跨 cue 的碎片按「句末标点 / 停顿 / 最大长度」合并成完整句；
 *   3. 没有标点时按字符预算兜底切分，英文约 110 字符、中文约 64 字符；
 *   4. 保留原 start，duration 用合并段落的结束时间减去开始时间。
 * ============================================================================
 */

const CJK_RE = /[\u3400-\u9fff]/u;
const CJK_GLOBAL_RE = /[\u3400-\u9fff]/gu;
const TERMINAL_RE = /[.!?…。！？]/u;
const CJK_TERMINAL_RE = /[。！？…]/u;
const SOFT_BREAK_RE = /[,;:，；：、]$/u;
const CLOSING_QUOTES = new Set(['"', "'", '”', '’', ')', ']', '】', '》']);
const TAG_ONLY_RE = /^\[(?:music|applause|laughter|silence|inaudible|sound effects?)\]$/i;

const DEFAULT_LIMITS = {
  maxLatin: 110,
  maxCjk: 64,
  minLatin: 20,
  minCjk: 14,
  pauseLatin: 0.9,
  pauseCjk: 0.65,
};

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countCjk(text) {
  return (String(text || '').match(CJK_GLOBAL_RE) || []).length;
}

function textLimits(text, limits) {
  const s = String(text || '');
  const cjk = countCjk(s);
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const isCjk = cjk > 0 && (cjk >= letters * 0.5 || !letters);
  return isCjk
    ? { max: limits.maxCjk, min: limits.minCjk, pause: limits.pauseCjk }
    : { max: limits.maxLatin, min: limits.minLatin, pause: limits.pauseLatin };
}

/** 把同一 cue 内的多个完整句切开，标点保留在句尾。 */
function splitSentences(text) {
  const s = String(text || '');
  const parts = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (!TERMINAL_RE.test(s[i])) continue;
    let end = i + 1;
    while (end < s.length && CLOSING_QUOTES.has(s[end])) end += 1;
    const next = end < s.length ? s[end] : '';
    const isCjkTerminal = CJK_TERMINAL_RE.test(s[i]);
    if (isCjkTerminal || !next || /\s/.test(next)) {
      const piece = s.slice(start, end).trim();
      if (piece) parts.push(piece);
      start = end;
      i = end - 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [s.trim()].filter(Boolean);
}

/** 在标点 / 空格处切长句；中文没有空格时按字符硬切。 */
function splitLongPiece(text, max) {
  let rest = String(text || '').trim();
  const chunks = [];
  while (rest.length > max) {
    const window = rest.slice(0, max + 18);
    let cut = -1;
    for (let i = window.length - 1; i >= Math.floor(max * 0.45); i -= 1) {
      if (/[,;:，；：、]/.test(window[i])) { cut = i + 1; break; }
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      if (space >= Math.floor(max * 0.45)) cut = space;
    }
    if (cut < 0) cut = max;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

function joinParts(parts) {
  let out = '';
  for (const raw of parts) {
    const piece = String(raw || '').trim();
    if (!piece) continue;
    if (!out) { out = piece; continue; }
    const left = out[out.length - 1];
    const right = piece[0];
    const leftCjk = CJK_RE.test(left);
    const rightCjk = CJK_RE.test(right);
    if (leftCjk || rightCjk || /^[,.;:!?…。！？，；：、]/.test(right)) out += piece;
    else out += ' ' + piece;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function sentenceEnds(text) {
  return /[.!?…。！？](?:["'”’)\]]*)$/u.test(String(text || '').trim());
}

/**
 * 输出前修时间轴：保证 start 严格递增、duration 为正。
 * YouTube 自动字幕有时 duration=0（同一 cue 切出的两句共享同一个 start），
 * 1:1 落库后两句在播放器里落在同一时间点，「上一句」seek 等于没动，
 * 前端按 start 取「最后一条」会永远落回后一句，表现为该句的「上一句」失灵。
 */
function normalizeTimeline(cues) {
  const out = [];
  let prevStart = -Infinity;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    let start = Number(cue.start);
    if (!Number.isFinite(start)) continue;
    if (start <= prevStart) start = prevStart + 0.05;
    const next = cues[i + 1];
    const nextStart = Number.isFinite(Number(next?.start)) ? Number(next.start) : null;
    let duration = Number(cue.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = nextStart != null && nextStart > start ? nextStart - start : 1.2;
    }
    out.push({
      ...cue,
      start: Number(start.toFixed(3)),
      duration: Number(Math.max(0.05, duration).toFixed(3)),
    });
    prevStart = start;
  }
  return out;
}

/**
 * 把 YouTube / ASR 的碎片 cue 合并为句子级 cue。
 * @param {Array<{text:string,start?:number,duration?:number}>} rawCues
 * @param {object} [options] 覆盖默认字符 / 停顿阈值
 * @returns {Array<{text:string,start:number,duration:number}>}
 */
export function segmentYouTubeCues(rawCues, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const cues = [];
  for (const cue of Array.isArray(rawCues) ? rawCues : []) {
    const text = cleanText(cue?.text);
    if (!text || TAG_ONLY_RE.test(text)) continue;
    const start = Number(cue?.start);
    if (!Number.isFinite(start)) continue;
    const duration = Math.max(0, Number(cue?.duration) || 0);
    cues.push({ text, start, duration });
  }
  // 某些 API 只给 start 不给 dur：用下一条 cue 的 start 推断本条时长，避免所有小句挤在同一时刻。
  for (let i = 0; i < cues.length; i += 1) {
    if (cues[i].duration > 0) continue;
    const next = cues[i + 1];
    if (next && next.start > cues[i].start) cues[i].duration = next.start - cues[i].start;
    // 拿不到下一条的起点（ASR 连续给同一个 start）时按字符估一个时长，
    // 否则同一 cue 里切出的两句会共享同一个 start，播放弹窗里「上一句」无法跳回。
    else cues[i].duration = Math.max(0.8, Math.min(6, cues[i].text.length * 0.055));
  }

  const out = [];
  let buffer = null;

  const flush = () => {
    if (!buffer || !buffer.parts.length) { buffer = null; return; }
    const text = joinParts(buffer.parts);
    if (text) {
      out.push({
        text,
        start: Number(buffer.start.toFixed(3)),
        duration: Number(Math.max(0, buffer.end - buffer.start).toFixed(3)),
      });
    }
    buffer = null;
  };

  const append = (text, start, duration) => {
    const piece = String(text || '').trim();
    if (!piece) return;
    const effectiveDuration = Math.max(0, Number(duration) || 0);
    const end = start + effectiveDuration;
    const pieceLimits = textLimits(piece, limits);

    if (buffer) {
      const current = joinParts(buffer.parts);
      const currentLimits = textLimits(current, limits);
      const gap = start - buffer.end;
      const joinedLength = current.length + piece.length + 1;
      // 自动字幕的 cue 间隔经常是显示节奏造成的（同一句也会隔 1~2 秒），
      // 所以只有当前已经积累到接近上限时才按停顿断开；短碎片优先合并成完整句。
      const pauseMin = Math.max(currentLimits.min, Math.floor(currentLimits.max * 0.45));
      const pauseBreak = gap >= currentLimits.pause && current.length >= pauseMin;
      const lengthBreak = current.length >= currentLimits.min && joinedLength > currentLimits.max;
      if (pauseBreak || lengthBreak) flush();
    }

    if (!buffer) buffer = { parts: [], start, end };
    buffer.parts.push(piece);
    buffer.end = Math.max(buffer.end, end);
    const currentText = joinParts(buffer.parts);
    if (sentenceEnds(piece)) flush();
    else if (currentText.length >= pieceLimits.max && SOFT_BREAK_RE.test(currentText)) flush();
  };

  for (const cue of cues) {
    const pieces = splitSentences(cue.text);
    const totalChars = pieces.reduce((n, p) => n + Math.max(1, p.length), 0) || 1;
    const cueEnd = cue.start + cue.duration;
    let cursor = cue.start;
    for (const piece of pieces) {
      const share = Math.max(1, piece.length) / totalChars;
      const pieceDuration = Math.max(0, (cueEnd - cue.start) * share);
      const pieceStart = cursor;
      cursor += pieceDuration;
      const maxForPiece = textLimits(piece, limits).max;
      const chunks = splitLongPiece(piece, maxForPiece);
      const chunkChars = chunks.reduce((n, part) => n + Math.max(1, part.length), 0) || 1;
      let chunkCursor = pieceStart;
      for (const chunk of chunks) {
        const chunkDuration = pieceDuration * (Math.max(1, chunk.length) / chunkChars);
        append(chunk, chunkCursor, chunkDuration);
        chunkCursor += chunkDuration;
      }
    }
  }
  flush();
  return normalizeTimeline(out);
}

export default { segmentYouTubeCues };
