// lib/protocol-features.mjs —— 协议特性兼容表与派发前 preflight。
//
// 同一 major 内允许 minor 偏斜（1.7/1.8 扩展仍可连接），但新参数在新版本才被理解：
// 旧扩展会静默忽略 `unverified`、`expect` 等字段，等于"看着调用成功、实际没校验"。
// 所以在 daemon 派发前按特性表检查对端协议版本，缺特性就明确报错，而不是放行。

/** 特性 → 对端扩展至少需要的协议版本。 */
export const FEATURE_MIN_PROTOCOL = {
  unverified: '1.9',
  expect: '1.9',
  read: '1.9',
  'observe-delta': '1.9',
  plan: '1.9',
};

const METHOD_FEATURE = {
  read: 'read',
  plan: 'plan',
};

/** 根据方法 + 参数推导这次调用依赖哪些新特性。 */
export function featuresForCall(method, params = {}) {
  const features = new Set();
  if (METHOD_FEATURE[method]) features.add(METHOD_FEATURE[method]);
  if (params && params.unverified === true) features.add('unverified');
  if (params && Array.isArray(params.expect) && params.expect.length) features.add('expect');
  if (params && params.delta === true) features.add('observe-delta');
  return [...features];
}

/**
 * @param {{ protocol?: string }} peer 已连接的浏览器实例
 * @param {string[]} features
 * @param {(a: string, b: string) => number|null} compare 协议版本比较函数
 * @returns {Array<{feature: string, required: string, actual: string}>}
 */
export function featureShortfall(peer, features, compare) {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const missing = [];
  for (const feature of features) {
    const required = FEATURE_MIN_PROTOCOL[feature];
    if (!required) continue;
    const result = typeof compare === 'function' ? compare(protocol, required) : null;
    if (result === null || result < 0) {
      missing.push({ feature, required, actual: protocol || 'unknown' });
    }
  }
  return missing;
}

export const FEATURE_RECOVERY = '升级浏览器扩展后重试（扩展与 daemon 协议需 1.9）；旧扩展会静默忽略这些参数。';
