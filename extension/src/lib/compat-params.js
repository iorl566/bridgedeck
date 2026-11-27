// src/lib/compat-params.js —— 外部兼容字段 → 扩展内部参数的归一化。
//
// 兼容目标 0.5.0 的部分工具参数名/形状与我方不同；schema 已接受这些字段
// （lib/schemas.mjs），这里负责把它们映射到既有实现真正消费的内部参数，
// 避免"schema 收了但行为没变"。未实现语义（如 upload drop 模式）明确报错。
import { bridgeError } from '../errors.js';

const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 });
const DRAG_MODE = Object.freeze({ 'press-move-release': 'hold', 'click-move-click': 'click-move-click', hold: 'hold', 'click-move-click': 'click-move-click' });

function modifierBits(value, field) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const bits = MODIFIER_BITS[value.toLowerCase()];
    if (bits === undefined) throw bridgeError('E_BAD_ARG', field + ' 含未知修饰键：' + value);
    return bits;
  }
  if (!Array.isArray(value)) throw bridgeError('E_BAD_ARG', field + ' 必须是数组或整数位掩码');
  let bits = 0;
  for (const item of value) {
    const key = String(item || '').toLowerCase();
    const bit = MODIFIER_BITS[key];
    if (bit === undefined) throw bridgeError('E_BAD_ARG', field + ' 含未知修饰键：' + item);
    bits |= bit;
  }
  return bits;
}

function dragPoint(value, field) {
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    return text.startsWith('@') ? { ref: text } : { selector: text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bridgeError('E_BAD_ARG', field + ' 必须是对象（ref/selector 或 x/y）');
  }
  if (value.ref !== undefined || value.selector !== undefined) return value;
  if (Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) {
    return { x: Number(value.x), y: Number(value.y) };
  }
  throw bridgeError('E_BAD_ARG', field + ' 需要 ref/selector 或 x/y');
}

export function normalizeCompatParams(method, params) {
  const out = { ...(params && typeof params === 'object' ? params : {}) };
  switch (method) {
    case 'read':
      if (Array.isArray(out.fields) && out.fieldsJson === undefined) {
        out.fieldsJson = JSON.stringify(out.fields);
      }
      return out;
    case 'extract':
      if (out.action !== undefined && !['table', 'list', 'discover'].includes(String(out.action))) {
        throw bridgeError('E_BAD_ARG', 'extract action 只能是 table/list/discover');
      }
      const targetId = out.targetId !== undefined ? out.targetId : out.target_id;
      if (targetId !== undefined && out.target === undefined) out.target = targetId;
      const itemSelector = out.itemSelector !== undefined ? out.itemSelector : out.item_selector;
      if (itemSelector !== undefined && out.itemSelector === undefined) out.itemSelector = itemSelector;
      if (Array.isArray(out.fields) && out.fieldsJson === undefined) out.fieldsJson = JSON.stringify(out.fields);
      return out;
    case 'drag': {
      const source = out.source !== undefined ? out.source : out.src;
      if (source !== undefined && out.from === undefined) out.from = dragPoint(source, 'source');
      const target = out.target !== undefined ? out.target : out.to;
      if (target !== undefined && out.to === undefined) out.to = dragPoint(target, 'target');
      const delta = out.delta !== undefined ? out.delta : out.deltaPoint;
      if (delta !== undefined) {
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
          throw bridgeError('E_BAD_ARG', 'delta 必须是 {x,y}');
        }
        if (Number.isFinite(Number(delta.x)) && out.dx === undefined) out.dx = Number(delta.x);
        if (Number.isFinite(Number(delta.y)) && out.dy === undefined) out.dy = Number(delta.y);
      }
      const mode = out.mode !== undefined ? out.mode : out.modeValue;
      if (mode !== undefined) {
        const mapped = DRAG_MODE[String(mode)];
        if (!mapped) throw bridgeError('E_BAD_MODE', 'mode 只能是 press-move-release 或 click-move-click');
        out.mode = mapped;
      }
      if (out.modifiers !== undefined) out.modifiers = modifierBits(out.modifiers, 'modifiers');
      return out;
    }
    case 'wheel':
      if (out.modifiers !== undefined) out.modifiers = modifierBits(out.modifiers, 'modifiers');
      return out;
    case 'upload':
      // upload 的 drop 模式已有真实实现（file-transfer.js），只做取值校验。
      if (out.mode !== undefined && !['input', 'drop'].includes(String(out.mode))) {
        throw bridgeError('E_BAD_ARG', 'upload mode 只能是 input/drop');
      }
      return out;
    case 'record.start':
      const traceVersion = out.traceVersion !== undefined ? out.traceVersion : out.trace_version;
      if (traceVersion !== undefined && ![2, 3].includes(Number(traceVersion))) {
        throw bridgeError('E_BAD_ARG', 'trace_version 只能是 2 或 3');
      }
      if (traceVersion !== undefined && out.traceVersion === undefined) out.traceVersion = Number(traceVersion);
      const redact = out.redactValues !== undefined ? out.redactValues : out.redact_values;
      if (redact !== undefined && out.redactValues === undefined) out.redactValues = redact;
      const tabSwitch = out.supportsTabSwitchSteps !== undefined ? out.supportsTabSwitchSteps : out.supports_tab_switch_steps;
      if (tabSwitch !== undefined && out.supportsTabSwitchSteps === undefined) out.supportsTabSwitchSteps = tabSwitch;
      return out;
    default:
      return out;
  }
}
