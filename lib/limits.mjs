// lib/limits.mjs —— 跨进程/协议边界的大小上限（零依赖）。
//
// 参考实现给 operation.await 设 4 MiB 上限；超限时返回明确错误，
// 避免把超大结果继续复制到 CLI/HTTP/JSON 层。

export const OPERATION_MAX_BYTES = 4 * 1024 * 1024;

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value === undefined ? null : value), 'utf8');
  } catch {
    return Infinity;
  }
}

export function enforceOperationLimit(result) {
  const bytes = jsonByteLength(result);
  if (bytes > OPERATION_MAX_BYTES) {
    const error = new Error(`operation 结果 ${bytes} 字节，超过 ${OPERATION_MAX_BYTES} 字节上限`);
    error.code = 'E_RESULT_TOO_LARGE';
    error.data = { bytes, limit: OPERATION_MAX_BYTES };
    throw error;
  }
  return result;
}
