/**
 * 分层文档摘要：L1 是当前文档，L2 是遮挡/弹窗层。
 * 纯函数，方便单测；不读页面、不做动作。
 * 有层模型事实时在行尾追加 "[kind z=N blocking]"（见 lib/vom-layers.js）。
 */
import { describeLayer } from './vom-layers.js';

export function formatLayerSummary(url, layers) {
  const list = Array.isArray(layers) ? layers.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = list.map((layer) => {
    const rect = layer.bounds
      ? ` @ ${Math.round(layer.bounds.x)},${Math.round(layer.bounds.y)} ${Math.round(layer.bounds.width)}x${Math.round(layer.bounds.height)}`
      : '';
    const pct = Number.isFinite(layer.coverage) ? ` (${Math.round(layer.coverage * 100)}%)` : '';
    const model = describeLayer({ kind: layer.layerKind || layer.kind, zIndex: layer.zIndex, blocking: layer.blocking });
    const suffix = model ? ` [${model}]` : '';
    return `- ${layer.level || 'L2'} ${layer.role || 'overlay'} ${JSON.stringify(String(layer.name || '').slice(0, 80))}${pct}${rect}${suffix}`;
  });
  return '── layers ──\n- L1 ' + JSON.stringify(String(url || '')) + '\n' + lines.join('\n');
}
