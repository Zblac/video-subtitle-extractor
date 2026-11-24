/**
 * ============================================================================
 * 字幕解析工具（纯函数，无 IO、无 DB、无 HTTP）
 * 所属层：utils —— 被 services / controllers / 前端解析接口复用。
 * 职责：把 SRT / WebVTT / YouTube timedtext(srv3,xml) / SBV / ASS/SSA / LRC / 纯文本
 *       统一解析成 Cue[]，或把 Cue[] 序列化为 SRT。
 * Cue = { index(从0), start(秒), end(秒), text(纯文本) }
 * 迁移说明：本文件从原 server/subtitles.js 迁入，导出签名保持不变；
 *           server/subtitles.js 现仅为 re-export 薄壳，兼容旧引用。
 * ============================================================================
 */

function decodeEntities(s) {
  return s
    .replace(/&amp;#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 去除行内样式标签（VTT <c>, <i>, <b>, <u>, <ruby>, 时间戳标签等） */
function stripTags(s) {
  return decodeEntities(
    s
      .replace(/<(?!\d{1,2}:\d{2})\/?[a-zA-Z][^>]*>/g, '') // 标签，但保留 <00:00:01.234> 这类内联时间戳
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/<\d{1,2}:\d{2}[.:]\d{2}[.:]?\d*>/g, '') // 内联时间戳
  );
}

/** 解析时间戳，支持 00:00:01,234 / 00:01.234 / 01.234 / 秒 */
function parseTime(token) {
  if (typeof token === 'number') return token;
  const t = token.trim().replace(',', '.');
  const m = t.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.](\d{1,3})/);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    const msStr = m[4];
    const ms = parseInt(msStr.padEnd(3, '0').slice(0, 3), 10);
    return h * 3600 + min * 60 + sec + ms / 1000;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function cleanTextLines(lines) {
  const text = lines
    .map((l) => stripTags(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

const TIME_LINE =
  /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3}|\d{1,2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3}|\d{1,2}[.,]\d{3})/;

/** 统一解析 SRT / VTT（按块切分，容错强） */
export function parseSrtVtt(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('字幕内容为空');
  let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 去掉 WEBVTT 头部 / NOTE / STYLE / REGION 块
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  let idx = 0;

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const head = lines[0].trim();
    if (/^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/i.test(head)) {
      // STYLE/REGION 块内可能多行，整体跳过
      if (/^(WEBVTT|STYLE|REGION|NOTE)/i.test(head)) continue;
    }
    // 找时间行（可能在第 0 行，也可能在序号行之后）
    let timeLineIdx = lines.findIndex((l) => TIME_LINE.test(l));
    if (timeLineIdx === -1) continue;
    const mm = lines[timeLineIdx].match(TIME_LINE);
    const start = parseTime(mm[1]);
    let end = parseTime(mm[2]);
    const bodyLines = lines.slice(timeLineIdx + 1);
    const body = cleanTextLines(bodyLines);
    if (start === null || !body) continue;
    if (end === null || end <= start) end = start + 2;
    cues.push({ index: idx++, start: round3(start), end: round3(end), text: body });
  }

  if (!cues.length) throw new Error('字幕文件无法识别：未解析到任何带时间戳的句子');
  return mergeOverlaps(cues);
}

/** YouTube timedtext 返回的 srv3/xml 格式 */
export function parseYouTubeXml(xml) {
  if (!xml || !/<(?:transcript|timedtext)/i.test(xml)) {
    throw new Error('不是 YouTube timedtext XML');
  }
  const cues = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  let idx = 0;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const bodyRaw = m[2] || '';
    const startAttr = attrs.match(/\bstart="([-\d.]+)"/);
    const durAttr = attrs.match(/\bdur="([\d.]+)"/);
    if (!startAttr) continue;
    const start = parseFloat(startAttr[1]);
    let dur = durAttr ? parseFloat(durAttr[1]) : 0;
    let body = decodeEntities(bodyRaw)
      .replace(/<[^>]+>/g, '')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    if (!dur || dur <= 0) dur = 2.5;
    cues.push({ index: idx++, start: round3(Math.max(0, start)), end: round3(start + dur), text: body });
  }
  if (!cues.length) throw new Error('YouTube 字幕内容为空');
  // ASR 自动字幕常有滚动重复，做一次去重合并
  return dedupeAsr(cues);
}

/** 按时间重叠/包含合并，保证 cues 单调 */
function mergeOverlaps(cues) {
  const sorted = cues.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.start < prev.end) {
      if (c.end <= prev.end) continue; // 被包含
      prev.end = c.start; // 收紧前一句
    }
    c.index = out.length;
    out.push(c);
  }
  return out;
}

/** ASR 去重：连续文本包含且间隔极小的合并 */
function dedupeAsr(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && c.start - prev.start < 0.6 && c.text.includes(prev.text)) {
      prev.text = c.text;
      prev.end = c.end;
      continue;
    }
    out.push(c);
  }
  return out.map((c, i) => ({ ...c, index: i }));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** SBV（YouTube 旧字幕）格式：`0:00:01.000,0:00:03.000` + 下一行正文（也兼容正文同一行） */
export function parseSbv(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const cues = [];
  let idx = 0;
  // 只认「两个时间戳 + 逗号」的行；正文可以跟在同一行，也可以在下面的若干行
  const RE =
    /^\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3})\s*,\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3})\s*(?:,\s*(.*))?$/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(RE);
    if (!m) continue;
    const start = parseTime(m[1].replace(',', '.'));
    const end = parseTime(m[2].replace(',', '.'));
    const bodyLines = [];
    if (m[3] && m[3].trim()) bodyLines.push(m[3]);
    let j = i + 1;
    while (j < lines.length && !RE.test(lines[j]) && lines[j].trim() !== '') {
      bodyLines.push(lines[j]);
      j += 1;
    }
    i = j - 1;
    const body = stripTags(bodyLines.join(' ')).replace(/\s+/g, ' ').trim();
    if (start === null || !body) continue;
    cues.push({
      index: idx++,
      start: round3(Math.max(0, start)),
      end: round3(end === null || end <= start ? start + 2 : end),
      text: body,
    });
  }
  if (!cues.length) throw new Error('未识别到 SBV 字幕');
  return mergeOverlaps(cues);
}

/** SSA / ASS 格式：`Dialogue: Layer, Start, End, Style, Name, ML, MR, MV, Effect, Text` */
export function parseAss(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const cues = [];
  let idx = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!/^Dialogue:/i.test(t)) continue;
    const parts = t.replace(/^Dialogue:\s*/i, '').split(',');
    if (parts.length < 10) continue; // 标准 ASS 为 10 个字段
    const start = parseTime(parts[1].trim());
    const end = parseTime(parts[2].trim());
    const body = stripTags(parts.slice(9).join(',').trim()).replace(/\s+/g, ' ').trim();
    if (start === null || !body) continue;
    cues.push({
      index: idx++,
      start: round3(Math.max(0, start)),
      end: round3(end === null || end <= start ? start + 2 : end),
      text: body,
    });
  }
  if (!cues.length) throw new Error('未识别到 ASS/SSA 字幕');
  return mergeOverlaps(cues);
}

/** LRC 歌词：`[00:01.00]text` 或 `[00:01.00][00:02.00]text` */
export function parseLrc(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const cues = [];
  let idx = 0;
  const TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const times = [];
    let m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push(min * 60 + sec + ms / 1000);
    }
    const body = line.replace(TAG, '').trim();
    if (!times.length || !body) continue;
    const start = times[0];
    cues.push({
      index: idx++,
      start: round3(start),
      end: round3(times[times.length - 1] + Math.max(1.2, Math.round((body.length / 12) * 10) / 10)),
      text: body,
    });
  }
  if (!cues.length) throw new Error('未识别到 LRC 字幕');
  return mergeOverlaps(cues);
}

/** TTML / DFXP 时间表达式：`00:00:01.000` / `00:00:01:12`（帧）/ `1.5s` / `1500ms` / `75f` */
function ttmlTime(token, fps = 25) {
  const t = String(token || '').trim();
  if (!t) return null;
  const msOffset = t.match(/^([\d.]+)ms$/i);
  if (msOffset) return parseFloat(msOffset[1]) / 1000;
  const sOffset = t.match(/^([\d.]+)s$/i);
  if (sOffset) return parseFloat(sOffset[1]);
  const fOffset = t.match(/^([\d.]+)f$/i);
  if (fOffset) return parseFloat(fOffset[1]) / fps;
  const colon = t.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (colon) {
    const h = parseInt(colon[1], 10);
    const min = parseInt(colon[2], 10);
    const sec = parseInt(colon[3], 10);
    const frac = colon[4] ? parseInt(colon[4].padEnd(3, '0').slice(0, 3), 10) : 0;
    return h * 3600 + min * 60 + sec + frac / 1000;
  }
  return parseTime(t);
}

/** TTML / DFXP（`<tt><body><div><p begin end>`），也兼容 iTunes/Netflix 导出的 tt 文件 */
export function parseTtml(raw) {
  const xml = String(raw || '');
  if (!/<tt\b/i.test(xml)) throw new Error('不是 TTML/DFXP 字幕');
  const cues = [];
  let idx = 0;
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const begin = attrs.match(/\bbegin\s*=\s*"([^"]+)"/i) || attrs.match(/\bbegin\s*=\s*'([^']+)'/i);
    const end = attrs.match(/\bend\s*=\s*"([^"]+)"/i) || attrs.match(/\bend\s*=\s*'([^']+)'/i);
    const dur = attrs.match(/\bdur\s*=\s*"([^"]+)"/i);
    const body = decodeEntities(
      (m[2] || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const start = begin ? ttmlTime(begin[1]) : null;
    let stop = end ? ttmlTime(end[1]) : null;
    if (stop === null && dur) {
      const d = ttmlTime(dur[1]);
      if (d !== null && start !== null) stop = start + d;
    }
    cues.push({
      index: idx++,
      start: start === null ? null : round3(Math.max(0, start)),
      end: stop === null ? null : round3(stop),
      text: body,
    });
  }
  if (!cues.length) throw new Error('未识别到 TTML/DFXP 字幕');
  // 完全没有时间戳的 tt（纯转写导出）：退化成纯文本句子流
  if (cues.every((c) => c.start === null)) {
    return cues.map((c, i) => ({ index: i, text: c.text }));
  }
  const fixed = cues.map((c, i, arr) => {
    const start = c.start === null ? (arr[i - 1]?.end ?? 0) : c.start;
    const stop = c.end === null || c.end <= start ? start + 2 : c.end;
    return { index: c.index, start, end: stop, text: c.text };
  });
  return mergeOverlaps(fixed);
}

/** SAMI / SMI：`<SYNC Start=1000><P>text`，结束时间取下一个 SYNC */
export function parseSami(raw) {
  const html = String(raw || '');
  if (!/<sami\b/i.test(html)) throw new Error('不是 SAMI 字幕');
  const blocks = [...html.matchAll(/<sync\b([^>]*)>([\s\S]*?)(?=<sync\b|<\/body>|<\/sami>|$)/gi)];
  const cues = [];
  blocks.forEach((b) => {
    const startAttr = (b[1] || '').match(/start\s*=\s*"?([\d.]+)"?/i);
    const startMs = startAttr ? parseFloat(startAttr[1]) : NaN;
    if (!Number.isFinite(startMs)) return;
    const body = decodeEntities(String(b[2] || '').replace(/<[^>]+>/g, ' '))
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) return;
    cues.push({ index: cues.length, start: round3(startMs / 1000), end: null, text: body });
  });
  if (!cues.length) throw new Error('未识别到 SAMI 字幕');
  // 结束时间 = 下一条的起点；最后一条补 2 秒
  const fixed = cues.map((c, i) => {
    const next = cues[i + 1]?.start;
    return { ...c, end: round3(next && next > c.start ? next : c.start + 2) };
  });
  return mergeOverlaps(fixed);
}

/** MicroDVD（.sub）：`{startFrame}{endFrame}text`，按 fps（默认 25）换算成秒 */
export function parseMicroDvd(raw, fps = 25) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const fpsVal = Number(fps) > 0 ? Number(fps) : 25;
  const cues = [];
  let idx = 0;
  for (const line of lines) {
    const m = line.match(/^\s*\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    const start = parseInt(m[1], 10) / fpsVal;
    const end = parseInt(m[2], 10) / fpsVal;
    const body = stripTags(String(m[3] || '').replace(/\|/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    cues.push({
      index: idx++,
      start: round3(start),
      end: round3(end <= start ? start + 2 : end),
      text: body,
    });
  }
  if (!cues.length) throw new Error('未识别到 MicroDVD 字幕');
  return mergeOverlaps(cues);
}

/** JSON 字幕：YouTube json3（events[].segs[].utf8）或 [{start,end,text}] / {cues:[...]} */
export function parseJsonSubtitle(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || ''));
  } catch {
    throw new Error('不是合法的 JSON 字幕');
  }
  const cues = [];
  const push = (start, end, text) => {
    const body = stripTags(String(text || '')).replace(/\s+/g, ' ').trim();
    if (!body) return;
    cues.push({
      index: cues.length,
      start: start === null || start === undefined ? null : round3(Math.max(0, Number(start))),
      end: end === null || end === undefined ? null : round3(Number(end)),
      text: body,
    });
  };
  const events = Array.isArray(data?.events) ? data.events : null;
  if (events) {
    events.forEach((ev) => {
      const t = Number(ev?.tStartMs);
      if (!Number.isFinite(t)) return;
      const d = Number(ev?.dDurationMs) || 0;
      const segs = Array.isArray(ev?.segs) ? ev.segs : [];
      const text = segs.map((s) => s?.utf8 || '').join('');
      push(t / 1000, (t + (d || 2000)) / 1000, text);
    });
  } else {
    const list = Array.isArray(data) ? data : Array.isArray(data?.cues) ? data.cues : [];
    list.forEach((c) => {
      push(Number(c?.start ?? c?.startTime ?? c?.from), Number(c?.end ?? c?.endTime ?? c?.to), c?.text ?? c?.content ?? c?.value);
    });
  }
  if (!cues.length) throw new Error('未识别到 JSON 字幕');
  if (cues.every((c) => c.start === null)) return cues.map((c, i) => ({ index: i, text: c.text }));
  const fixed = cues.map((c, i, arr) => {
    const start = c.start === null ? (arr[i - 1]?.end ?? 0) : c.start;
    const stop = c.end === null || c.end <= start ? start + 2 : c.end;
    return { index: c.index, start, end: stop, text: c.text };
  });
  return mergeOverlaps(fixed);
}

/** 按句切分纯文本（先按换行分块，块内按句子边界/过长再细分），返回句子数组 */
function splitSentences(text) {
  const blocks = text.split(/\n+/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const parts = block.split(/(?<=[.!?…:;])\s+(?=[A-Z"'“([])/);
    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      while (p.length > 120) {
        const cutComma = p.lastIndexOf(',', 100);
        const cutSpace = p.lastIndexOf(' ', 110);
        const at = cutComma > 60 ? cutComma : cutSpace > 60 ? cutSpace : 110;
        const piece = p.slice(0, at).trim();
        if (piece) out.push(piece);
        p = p.slice(at).trim();
      }
      if (p) out.push(p);
    }
  }
  return out;
}

/** 纯文本 TXT：无时间戳，按句切分；编辑页用短号（1、2、3…）标记，不再生成模拟时间轴 */
export function parsePlainText(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('字幕内容为空');
  const body = text.replace(/^\s*(WEBVTT|NOTE|STYLE|REGION)[\s\S]*?\n{2,}/i, '').trim();
  if (!body) throw new Error('字幕内容为空');
  const sentences = splitSentences(body);
  if (!sentences.length) throw new Error('未能从文本中切分出句子');
  return sentences.map((s, i) => ({ index: i, text: s }));
}

/** 自动探测格式并解析
 *  支持：SRT / WebVTT / YouTube XML(srv3) / TTML / DFXP / SAMI(.smi) / SBV /
 *        ASS / SSA / LRC / MicroDVD(.sub) / JSON(json3) / 纯文本 TXT / MD
 *  探测顺序按「结构特征显式程度」排列：先结构化容器，再时间行，最后兜底纯文本。
 */
export function parseSubtitle(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('字幕内容为空');

  // 1) XML 家族：YouTube timedtext / TTML / DFXP / SAMI（都必须在纯文本兜底之前判断，
  //    否则整份 XML 会被当成「正文」写进句子列表）
  if (/^<sami\b/i.test(trimmed) || /<\/sami>$/i.test(trimmed)) return parseSami(trimmed);
  if (/<tt\b[^>]*xmlns|<tt\b[\s>]/i.test(trimmed) && /<p\b[^>]*(begin|end)=/i.test(trimmed)) {
    return parseTtml(trimmed);
  }
  if (/^<(?:\?xml|transcript|timedtext)/i.test(trimmed)) return parseYouTubeXml(trimmed);

  // 2) JSON（json3 / 数组形式）
  if (/^[{[][\s\S]*[}\]]$/.test(trimmed) && /"(?:events|segs|tStartMs|cues)"|\{/i.test(trimmed)) {
    try {
      return parseJsonSubtitle(trimmed);
    } catch {
      /* 不是字幕 JSON：继续往下按文本处理 */
    }
  }

  // 3) 带时间轴的行式字幕
  if (TIME_LINE.test(trimmed)) return parseSrtVtt(raw); // SRT / WebVTT
  if (/^\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3}\s*,\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{0,3}/m.test(trimmed))
    return parseSbv(raw); // SBV
  if (/^\s*Dialogue:/mi.test(trimmed)) return parseAss(raw); // ASS / SSA
  if (/^\s*\[\d{1,2}:\d{1,2}(?:[.:]\d{0,3})?\]/m.test(trimmed)) return parseLrc(raw); // LRC
  if (/^\s*\{\d+\}\{\d+\}/m.test(trimmed)) return parseMicroDvd(raw); // MicroDVD .sub

  // 4) 兜底：纯文本（TXT / MD / 无时间戳转写稿）
  return parsePlainText(raw);
}
