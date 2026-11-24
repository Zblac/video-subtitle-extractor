/**
 * 配置读取：.env（项目根）+ 环境变量 + 命令行覆盖。
 * Token 不写入任何日志/报告。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 用户级数据目录（模型缓存 / 输出 / 状态），默认 ~/.video-subtitle-extractor。
 * 把重资产放在家目录而不是技能目录，方便技能整体升级而不用重下 500MB 模型。
 */
export const HOME = process.env.VSX_HOME || path.join(os.homedir(), '.video-subtitle-extractor');

/** 极简 .env 解析（KEY=VALUE，支持 # 注释与引号），不引入第三方依赖。 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export const ENV = { ...loadDotEnv(path.join(ROOT, '.env')), ...process.env };

// 复制过来的适配层直接读 process.env（原项目由 dotenv 注入），这里补上桥接，
// 保证 .env 里的 token / API 地址对 lib/ 下的服务生效。
for (const key of ['YOUTUBE_TRANSCRIPT_API_TOKEN', 'YOUTUBE_TRANSCRIPT_API_URL']) {
  if (!process.env[key] && ENV[key]) process.env[key] = ENV[key];
}

export function config(overrides = {}) {
  const proxy = overrides.proxy ?? ENV.YTSUB_PROXY ?? ENV.HTTPS_PROXY ?? ENV.https_proxy ?? '';
  return {
    apiUrl: (ENV.YOUTUBE_TRANSCRIPT_API_URL || 'https://www.youtube-transcript.io/api/transcripts').trim(),
    token: (ENV.YOUTUBE_TRANSCRIPT_API_TOKEN || '').trim(),
    python: ENV.VSX_PYTHON || ENV.YTSUB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ffmpeg: ENV.YTSUB_FFMPEG || 'ffmpeg',
    modelDir: ENV.VSX_MODEL_DIR || ENV.YTSUB_MODEL_DIR || path.join(HOME, 'models'),
    outDir: overrides.outDir || ENV.VSX_OUT_DIR || ENV.YTSUB_OUT_DIR || path.join(HOME, 'out'),
    proxy: proxy.trim(),
    model: overrides.model || ENV.YTSUB_WHISPER_MODEL || 'small',
    device: overrides.device || ENV.YTSUB_WHISPER_DEVICE || 'auto',
    computeType: overrides.computeType || ENV.YTSUB_WHISPER_COMPUTE || 'auto',
  };
}

/** 把 token 从任意字符串里抹掉，避免错误信息泄漏。 */
export function scrub(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('***');
  return s;
}
