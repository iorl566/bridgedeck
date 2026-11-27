// CLI 侧解析 --vom-weights "interactive=40,text=2"：只允许已知权重键。
export const VOM_WEIGHT_KEYS = ['interactive', 'semanticRole', 'formControl', 'text', 'area', 'depth', 'offscreen', 'duplicate', 'hidden'];

export function parseVomWeights(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(/[,;]/)) {
    const item = part.trim();
    if (!item) continue;
    const [key, valueText] = item.split('=');
    const keyName = String(key || '').trim();
    if (!VOM_WEIGHT_KEYS.includes(keyName)) throw new Error('未知 VOM 权重：' + keyName);
    const value = Number(valueText);
    if (!Number.isFinite(value) || Math.abs(value) > 1000) throw new Error('VOM 权重值不合法：' + item);
    out[keyName] = value;
  }
  return out;
}
