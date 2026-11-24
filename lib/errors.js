/**
 * ============================================================================
 * 统一 HTTP 业务错误 —— 从 server/store.js 提取，全工程共享。
 * 约定：业务层一律 throw httpError(status, message)，
 *       路由层（handler / sendError）读取 e.status 决定 HTTP 状态码。
 * ============================================================================
 */

/**
 * 构造带 HTTP 状态码的业务错误。
 * @param {number} status HTTP 状态码（400/401/403/404/409/422/429/502/503...）
 * @param {string} message 面向用户的错误描述
 * @param {string} [code] 业务错误码（可选）；透传到响应体 e.code
 * @returns {Error & { status: number, code?: string }}
 */
export function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}
