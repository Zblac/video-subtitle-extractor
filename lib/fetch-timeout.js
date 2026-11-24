/**
 * 带超时的 fetch（外部 AI / 字幕 / 网页服务共用）。
 * 超时抛出面向用户的中文错误；错误信息不包含密钥、令牌或响应原文。
 *
 * 错误状态映射（避免被 errorMiddleware 一律当成 500）：
 *  - 超时（AbortError）            → 504
 *  - URL 非法（ERR_INVALID_URL）   → 400
 *  - 其余连接 / DNS / TLS 失败    → 502
 */
import { httpError } from './errors.js';

export const AI_TIMEOUT_MS = 20000;
export const TRANSCRIPT_TIMEOUT_MS = 15000;

/**
 * 判断异常是否为「URL 本身非法」（Node fetch 抛 TypeError ERR_INVALID_URL）。
 * @param {any} e
 */
function isInvalidUrl(e) {
  const code = e?.cause?.code || e?.code;
  return code === 'ERR_INVALID_URL' || /Invalid URL|URL must be/i.test(e?.message || '');
}

/**
 * @param {string} url
 * @param {RequestInit & { dispatcher?: any }} options
 * @param {number} timeoutMs
 * @param {string} label
 * @param {typeof fetch} [fetchImpl] 允许注入 undici.fetch（带 ProxyAgent.dispatcher）
 */
export async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = AI_TIMEOUT_MS,
  label = '外部服务',
  fetchImpl = fetch
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    const causeCode = e?.cause?.code || e?.code || null;
    const causeMessage = String(e?.cause?.message || e?.message || '').slice(0, 300) || null;
    if (e?.name === 'AbortError') {
      const err = httpError(504, `${label}请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`);
      err.causeCode = 'ABORT_TIMEOUT';
      err.causeMessage = causeMessage;
      throw err;
    }
    if (isInvalidUrl(e)) {
      const err = httpError(400, `${label}地址格式无效，请检查链接是否以 http:// 或 https:// 开头`);
      err.causeCode = causeCode || 'ERR_INVALID_URL';
      err.causeMessage = causeMessage;
      throw err;
    }
    const err = httpError(502, `${label}无法连接，请检查网络或服务地址配置`);
    err.causeCode = causeCode;
    err.causeMessage = causeMessage;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
