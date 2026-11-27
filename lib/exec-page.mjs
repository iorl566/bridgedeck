// lib/exec-page.mjs —— bridge exec 的 page API（Node vm 与 QuickJS 共用同一份实现）。
//
// 这里只做“方法名 → RPC”的映射与少量结果整形；浏览器能力仍由 daemon/扩展提供。
// QuickJS 沙箱按本文件导出的方法清单生成 prelude，避免两边 API 漂移
// （历史上 QuickJS 的 locator 面比 vm 少，文档因此写着“QuickJS 不支持 locator”）。
//
// 约定：
// - 所有方法都返回 RPC 的 result；失败抛错（带 code/data），由调用方决定如何呈现。
// - target 支持 `@e1`、CSS selector、`{ref}|{selector}|{stableRef}`。

/** page 上直接暴露的 RPC 方法（名字与 RPC 同名；locator/webmcp 另有专门实现）。 */
export const PAGE_METHODS = [
  'goto', 'navigate', 'observe', 'click', 'fill', 'press', 'read',
  'evaluate', 'wait', 'waitFor', 'screenshot',
];

/** page.locator(target) 返回对象上的方法名（vm 与 QuickJS 必须一致）。 */
export const LOCATOR_METHODS = [
  // 动作
  'click', 'hover', 'focus', 'scrollIntoView', 'fill', 'press', 'selectOption',
  // 读取
  'read', 'inputValue', 'textContent', 'getAttribute', 'isVisible', 'isHidden',
  'isAttached', 'isEnabled', 'actionable', 'count',
  // 证据 / 等待
  'screenshot', 'waitFor', 'waitForVisible', 'waitForHidden', 'waitForAttached', 'waitForDetached',
];

const TARGET_ERROR = 'page target 需要 @ref / selector / { ref|selector }';

// locator.isVisible/isHidden/isAttached 用单次探测（extension 的 boundedTimeout 下限 100ms，
// 因此这里取 100ms：语义是“现在是否可见/在文档中”，不是长等待）。
export const LOCATOR_PROBE_TIMEOUT_MS = 100;

function badTarget() {
  const error = new Error(TARGET_ERROR);
  error.code = 'E_BAD_ARG';
  return error;
}

/** 把 target 归一成 RPC 的 ref/selector 参数。 */
export function execTarget(target) {
  if (typeof target === 'string' && target.startsWith('@')) return { ref: target };
  if (typeof target === 'string' && target) return { selector: target };
  if (target && typeof target === 'object') return { ...target };
  throw badTarget();
}

function firstField(result) {
  if (!result || !Array.isArray(result.fields) || !result.fields.length) return null;
  return result.fields[0] && typeof result.fields[0] === 'object' ? result.fields[0] : null;
}

/**
 * 构造 exec 的 page 对象。
 * @param {(method:string, params?:object)=>Promise<any>} call 已带 session/超时的 RPC 调用
 */
export function createExecPage(call) {
  if (typeof call !== 'function') throw new TypeError('createExecPage 需要 call 函数');

  function locator(target) {
    const spec = execTarget(target);
    const targetOf = () => ({ ...spec });

    const readFields = (fields) => call('read', { ...targetOf(), fields });

    const waitState = (state) => (options = {}) => call('wait-for-element', { ...targetOf(), state, ...options });

    const api = {
      click: (options = {}) => call('click', { ...targetOf(), ...options }),
      hover: (options = {}) => call('hover', { ...targetOf(), ...options }),
      focus: (options = {}) => call('focus', { ...targetOf(), ...options }),
      scrollIntoView: (options = {}) => call('scroll-to', { ...targetOf(), ...options }),
      fill: (value, options = {}) => call('fill', { ...targetOf(), value: String(value), ...options }),
      press: (key, options = {}) => call('press', { ...targetOf(), key: String(key), ...options }),
      selectOption: (value, options = {}) => call('select', { ...targetOf(), value: String(value), ...options }),

      read: () => call('read', targetOf()),
      // 表单控件的 value；非表单元素退回 textContent（fieldInfo 的既有语义）。
      inputValue: async () => {
        const field = firstField(await call('read', targetOf()));
        return field && field.value !== undefined ? field.value : null;
      },
      textContent: async () => {
        const field = firstField(await readFields([{ key: 'text', read: 'text' }]));
        return field && field.text !== undefined ? field.text : null;
      },
      getAttribute: async (name) => {
        if (typeof name !== 'string' || !name) {
          const error = new Error('locator.getAttribute 需要属性名');
          error.code = 'E_BAD_ARG';
          throw error;
        }
        const field = firstField(await readFields([{ key: 'value', read: 'attribute', attribute: name }]));
        return field && field.value !== undefined ? field.value : null;
      },
      isVisible: async (options = {}) => (await call('wait-for-element', { ...targetOf(), state: 'visible', timeoutMs: LOCATOR_PROBE_TIMEOUT_MS, ...options })).satisfied === true,
      isHidden: async (options = {}) => (await call('wait-for-element', { ...targetOf(), state: 'hidden', timeoutMs: LOCATOR_PROBE_TIMEOUT_MS, ...options })).satisfied === true,
      isAttached: async (options = {}) => (await call('wait-for-element', { ...targetOf(), state: 'attached', timeoutMs: LOCATOR_PROBE_TIMEOUT_MS, ...options })).satisfied === true,
      isEnabled: async () => {
        const field = firstField(await call('read', targetOf()));
        return Boolean(field) && field.disabled !== true;
      },
      actionable: () => call('actionable', targetOf()),
      count: async () => {
        if (!spec.selector) {
          const error = new Error('locator.count 只支持 CSS selector（ref 是单元素句柄）');
          error.code = 'E_BAD_ARG';
          throw error;
        }
        const result = await call('evaluate', { expression: 'document.querySelectorAll(' + JSON.stringify(spec.selector) + ').length' });
        return Number(result && result.value) || 0;
      },

      screenshot: (options = {}) => call('screenshot', { ...targetOf(), ...options }),
      waitFor: (options = {}) => call('wait-for-element', { ...targetOf(), ...options }),
      waitForVisible: waitState('visible'),
      waitForHidden: waitState('hidden'),
      waitForAttached: waitState('attached'),
      waitForDetached: waitState('detached'),
    };
    return api;
  }

  return {
    goto: (url) => call('navigate', { url: String(url) }),
    navigate: (url) => call('navigate', { url: String(url) }),
    observe: (options = {}) => call('observe', options),
    click: (target, options = {}) => call('click', { ...execTarget(target), ...options }),
    fill: (target, value, options = {}) => call('fill', { ...execTarget(target), value: String(value), ...options }),
    press: (key, options = {}) => call('press', { key: String(key), ...options }),
    read: (target) => call('read', execTarget(target)),
    evaluate: (expression) => call('evaluate', { expression: String(expression) }),
    wait: (ms) => call('wait-ms', { ms: Number(ms) || 0 }),
    waitFor: (target, options = {}) => call('wait-for-element', { ...execTarget(target), ...options }),
    screenshot: async (options = {}) => {
      const result = await call('screenshot', options);
      if (!result || typeof result !== 'object') return result;
      const { dataUrl, ...rest } = result;
      return rest;
    },
    locator,
    webmcp: {
      list: () => call('webmcp.list'),
      call: (name, input = {}) => call('webmcp.call', { name: String(name), input }),
    },
  };
}

/** page 的完整方法清单（含 locator 与 webmcp 两个专门入口）。 */
export function pageSurface() {
  return {
    methods: [...PAGE_METHODS, 'locator', 'webmcp'],
    locator: [...LOCATOR_METHODS],
  };
}
