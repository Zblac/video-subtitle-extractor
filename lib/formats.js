/**
 * 字幕格式化：cues -> SRT / VTT / TXT / JSON。
 * cues 形状统一为 { text, start, duration }（秒，浮点）。
 */
import fs from 'node:fs';

function pad(n, len = 2) {
  return String(Math.floor(n)).padStart(len, '0');
}

export function clock(seconds, sep = ',') {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  // 四舍五入到 1000ms 时进位
  if (ms === 1000) return clock(s + 0.001, sep);
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms, 3)}`;
}

export function toSrt(cues) {
  const lines = [];
  cues.forEach((c, i) => {
    const start = Number(c.start) || 0;
    const end = start + Math.max(0.05, Number(c.duration) || 0);
    lines.push(String(i + 1));
    lines.push(`${clock(start, ',')} --> ${clock(end, ',')}`);
    lines.push(String(c.text || '').trim());
    lines.push('');
  });
  return lines.join('\n');
}

export function toVtt(cues) {
  const lines = ['WEBVTT', ''];
  cues.forEach((c) => {
    const start = Number(c.start) || 0;
    const end = start + Math.max(0.05, Number(c.duration) || 0);
    lines.push(`${clock(start, '.')} --> ${clock(end, '.')}`);
    lines.push(String(c.text || '').trim());
    lines.push('');
  });
  return lines.join('\n');
}

export function toTxt(cues) {
  return cues.map((c) => String(c.text || '').trim()).filter(Boolean).join('\n') + '\n';
}

export function toJson(cues, meta = {}) {
  return JSON.stringify({ ...meta, count: cues.length, cues }, null, 2);
}

/** 一次写出四种格式，返回写出的路径列表。 */
export function writeAll(dir, base, cues, meta = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    srt: `${base}.srt`,
    vtt: `${base}.vtt`,
    txt: `${base}.txt`,
    json: `${base}.json`,
  };
  fs.writeFileSync(`${dir}/${files.srt}`, toSrt(cues), 'utf8');
  fs.writeFileSync(`${dir}/${files.vtt}`, toVtt(cues), 'utf8');
  fs.writeFileSync(`${dir}/${files.txt}`, toTxt(cues), 'utf8');
  fs.writeFileSync(`${dir}/${files.json}`, toJson(cues, meta), 'utf8');
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `${dir}/${v}`]));
}

export function durationOf(cues) {
  const last = cues[cues.length - 1];
  if (!last) return 0;
  return Number(last.start || 0) + Number(last.duration || 0);
}
