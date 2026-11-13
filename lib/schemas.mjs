// lib/schemas.mjs —— 轻量协议参数校验（零依赖，先覆盖 transfer.*）。
//
// 参考实现用 JSON Schema 约束方法参数；这里实现一个最小 validator，
// 让 daemon 在进入业务逻辑前给出稳定的 E_BAD_ARG 与字段路径。

const TRANSFER_ID = { type: 'string', pattern: '^tr_[0-9a-f]{16}$' };
const SESSION_FIELD = { type: 'string', minLength: 1 };
const MI_B = 1024 * 1024;
// 未单列的方法仍校验通用信封，避免 session/tabId 类型错误穿透到业务层。
const GENERIC_SCHEMA = {
  type: 'object',
  properties: {
    session: SESSION_FIELD,
    sessionId: SESSION_FIELD,
    tabId: { type: 'integer', minimum: 0 },
  },
};

export const METHOD_SCHEMAS = {
  observe: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      probeHover: { type: 'boolean' },
      debugSurfaces: { type: 'boolean' },
      closedShadow: { type: 'boolean' },
      vom: { type: 'boolean' },
      ax: { type: 'boolean' },
      maxTokens: { type: 'integer', minimum: 1, maximum: 20000 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 4096 },
    },
  },
  console: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      since: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
    },
  },
  navigate: {
    type: 'object',
    required: ['url'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      url: { type: 'string', minLength: 1, maxLength: 8192 },
    },
  },
  'wait-ms': {
    type: 'object',
    required: ['ms'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ms: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  'wait-for-element': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      state: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      operationId: { type: 'string', minLength: 1 },
    },
  },
  'wait-for-navigation': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      waitUntil: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
    },
  },
  click: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  hover: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  fill: {
    type: 'object',
    required: ['value'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      value: { type: 'string' },
      noClear: { type: 'boolean' },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  press: {
    type: 'object',
    required: ['key'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      key: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  select: {
    type: 'object',
    required: ['value'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      value: { type: 'string' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  read: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      all: { type: 'boolean' },
      fieldsJson: { type: 'string' },
    },
  },
  evaluate: {
    type: 'object',
    required: ['expression'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      expression: { type: 'string', minLength: 1, maxLength: 200000 },
    },
  },
  wheel: {
    type: 'object',
    properties: {
      deltaY: { type: 'number' },
      deltaX: { type: 'number' },
    },
  },
  drag: {
    type: 'object',
    properties: {
      modifiers: { type: 'integer', minimum: 0, maximum: 15 },
      steps: { type: 'integer', minimum: 2, maximum: 60 },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  'transfer.begin': {
    type: 'object',
    required: ['name', 'byteSize'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      byteSize: { type: 'integer', minimum: 1, maximum: 64 * MI_B },
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
    },
  },
  'transfer.chunk': {
    type: 'object',
    required: ['transferId', 'offset', 'dataBase64'],
    properties: {
      transferId: TRANSFER_ID,
      offset: { type: 'integer', minimum: 0 },
      dataBase64: { type: 'string', minLength: 1 },
    },
  },
  'transfer.finish': {
    type: 'object',
    required: ['transferId'],
    properties: { transferId: TRANSFER_ID },
  },
  'transfer.read': {
    type: 'object',
    required: ['transferId', 'offset'],
    properties: {
      transferId: TRANSFER_ID,
      offset: { type: 'integer', minimum: 0 },
      maxBytes: { type: 'integer', minimum: 1, maximum: MI_B },
    },
  },
  'transfer.release': {
    type: 'object',
    required: ['transferId'],
    properties: { transferId: TRANSFER_ID },
  },
  plan: {
    type: 'object',
    required: ['steps'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          required: ['method'],
          properties: {
            method: { type: 'string', minLength: 1 },
            params: { type: 'object' },
          },
        },
      },
    },
  },
  extract: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
    },
  },
  'extract.discover': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
    },
  },
  'extract.table': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      target: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
    },
  },
  'extract.list': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      itemSelector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
    },
  },
  screenshot: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['viewport', 'full', 'follow', 'current'] },
      fullPage: { type: 'boolean' },
      annotate: { type: 'boolean' },
      format: { type: 'string', minLength: 1 },
      region: { type: 'object', required: ['x', 'y', 'width', 'height'] },
    },
  },
  'record.start': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      purpose: { type: 'string' },
      maxPageTokens: { type: 'integer', minimum: 1 },
      screenshots: { type: 'boolean' },
    },
  },
  'record.stop': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } },
  },
  'record.list': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } },
  },
  'video.start': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      quality: { type: 'string' },
      durationMs: { type: 'integer', minimum: 0 },
    },
  },
  'video.stop': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 }, recording: { type: 'string' } },
  },
  'network.rule_add': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      rule: { type: 'object' },
    },
  },
};

// 其余扩展方法的显式 schema（覆盖门禁要求每个 EXT 方法都有条目）。
// 只声明确定存在的字段；未列出的字段会被 validator 忽略，避免误伤扩展侧参数。
const ENVELOPE_PROPS = { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } };
const TARGET_PROPS = { ref: { type: 'string', minLength: 1 }, selector: { type: 'string', minLength: 1 } };
const withProps = (extra = {}, required = []) => ({
  type: 'object',
  properties: { ...ENVELOPE_PROPS, ...extra },
  ...(required.length ? { required } : {}),
});
const withTarget = (extra = {}, required = []) => withProps({ ...TARGET_PROPS, ...extra }, required);

Object.assign(METHOD_SCHEMAS, {
  reload: withProps(),
  'navigate-back': withProps(),
  'navigate-forward': withProps(),
  snapshot: withProps(),
  'observe-frames': withProps({
    maxTokens: { type: 'integer', minimum: 1, maximum: 20000 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, maxLength: 4096 },
  }),
  actionable: withTarget(),
  blur: withTarget(),
  focus: withTarget(),
  'get-html': withTarget(),
  'scroll-to': withTarget(),
  'shadow.read': withTarget(),
  'shadow.click': withTarget({ text: { type: 'string' } }),
  upload: withTarget({ files: { type: 'array' }, paths: { type: 'array' } }),
  download: withTarget({ url: { type: 'string' }, out: { type: 'string' } }),
  'click-point': withProps({
    capture: { type: 'string' },
    imageX: { type: 'integer' },
    imageY: { type: 'integer' },
  }),
  'screenshot.manual.start': withProps(),
  'screenshot.manual.frame': withProps(),
  'screenshot.manual.save': withProps(),
  'tab.list': withProps({ scope: { type: 'string' } }),
  'tab.new': withProps({
    url: { type: 'string' },
    windowId: { type: 'integer', minimum: 0 },
    noFocus: { type: 'boolean' },
    incognito: { type: 'boolean' },
  }),
  'tab.close': withProps(),
  'tab.select': withProps(),
  'tab.borrow': withProps(),
  'tab.return': withProps(),
  'tab.move': withProps({
    windowId: { type: 'integer', minimum: 0 },
    index: { type: 'integer', minimum: 0 },
  }),
  'window.list': withProps(),
  'window.close': withProps({ windowId: { type: 'integer', minimum: 0 } }),
  'window.focus': withProps({ windowId: { type: 'integer', minimum: 0 } }),
  'window.resize': withProps({
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  }),
  'window.ensureAgent': withProps({ noFocus: { type: 'boolean' }, incognito: { type: 'boolean' } }),
  'window.newAgent': withProps({ noFocus: { type: 'boolean' }, incognito: { type: 'boolean' } }),
  'dialog.list': withProps(),
  'dialog.status': withProps(),
  'dialog.arm': withProps({
    alert: { type: 'string' },
    confirm: { type: 'string' },
    prompt: { type: 'string' },
    beforeUnload: { type: 'string' },
    promptText: { type: 'string' },
    queue: { type: 'boolean' },
  }),
  'dialog.disarm': withProps({}),
  'dialog.accept': withProps({ text: { type: 'string' } }),
  'dialog.dismiss': withProps({}),
  'dialog.handle': withProps({
    accept: { type: 'boolean' },
    dismiss: { type: 'boolean' },
    promptText: { type: 'string' },
  }),
  'network.start': withProps({ bodies: { type: 'boolean' } }),
  'network.stop': withProps(),
  'network.list': withProps({
    filter: { type: 'object' },
    since: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 },
  }),
  'network.detail': withProps(),
  'network.replay': withProps(),
  'debug.start': withProps({ name: { type: 'string' }, bodies: { type: 'boolean' } }),
  'debug.stop': withProps(),
  'debug.current': withProps(),
  'debug.request': withProps(),
  'debug.performance': withProps(),
  'debug.history': withProps(),
  'debug.delete': withProps(),
  'debug.fetch_probe': withProps({ ms: { type: 'integer', minimum: 1 } }),
  'debug.pin': withProps(),
  'debug.pinned': withProps(),
  'debug.capabilities': withProps(),
  'debug.rule_add': withProps({ rule: { type: 'object' } }),
  'debug.rule_list': withProps(),
  'debug.rule_clear': withProps(),
  'debug.rule_enable': withProps({ id: { type: 'integer' } }),
  'debug.rule_disable': withProps({ id: { type: 'integer' } }),
  'debug.rule_remove': withProps({ id: { type: 'integer' } }),
  'debug.rule_export': withProps({ output: { type: 'string' } }),
  'debug.rule_import': withProps({ rules: { type: 'array' } }),
  'video.start': withProps({
    durationMs: { type: 'integer', minimum: 0 },
    quality: { type: 'string' },
  }),
  'video.stop': withProps({ recording: { type: 'string' } }),
  'video.status': withProps({ recording: { type: 'string' } }),
  'video.list': withProps(),
  'video.fetch': withProps({ recording: { type: 'string' } }),
  'video.discard': withProps({ recording: { type: 'string' } }),
  'video.prune': withProps({ ttlMs: { type: 'integer', minimum: 0 } }),
  'video.recover': withProps(),
  'record.status': withProps(),
  'cooperate.sync': withProps({
    policy: { type: 'string' },
    probeHover: { type: 'boolean' },
    matchText: { type: 'string' },
    contextLines: { type: 'integer', minimum: 0 },
  }),
  'cooperate.wait': withProps({ timeoutMs: { type: 'integer', minimum: 1 } }),
  'cooperate.handback': withProps(),
  'operation.await': withProps({ timeoutMs: { type: 'integer', minimum: 1 } }),
  'operation.cancel': withProps(),
  'request-help': withProps({ reason: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 } }),
  emulate: withProps({
    device: { type: 'string' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    dpr: { type: 'number', minimum: 0 },
    mobile: { type: 'boolean' },
    ua: { type: 'string' },
    timezone: { type: 'string' },
    locale: { type: 'string' },
    geolocation: { type: 'object' },
    touch: { type: 'boolean' },
    reset: { type: 'boolean' },
  }),
  step: withProps({
    action: { type: 'object' },
    untilVisible: { type: 'string' },
    waitTimeoutMs: { type: 'integer', minimum: 0 },
    saveFull: { type: 'string' },
  }),
  'ui.open': withProps({ page: { type: 'string' }, query: { type: 'string' } }),
  'diagnostics.ui': withProps({ page: { type: 'string' } }),
  'control-hint': withProps({
    tabId: { type: 'integer', minimum: 0 },
    enabled: { type: 'boolean' },
  }),
  'debugger.detach': withProps({
    tabId: { type: 'integer', minimum: 0 },
  }),
});

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function typeMatches(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return valueType(value) === type;
}

function checkValue(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(path + ' 应为 ' + schema.type);
    return;
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(path + ' 至少 ' + schema.minItems + ' 项');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(path + ' 最多 ' + schema.maxItems + ' 项');
    if (schema.items) value.forEach((item, index) => checkValue(item, schema.items, path + '[' + index + ']', errors));
  }
  if (schema.type === 'object' && valueType(value) === 'object') {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) checkValue(value[key], child, path + '.' + key, errors);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(path + ' 长度至少 ' + schema.minLength);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(path + ' 长度最多 ' + schema.maxLength);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(path + ' 不能小于 ' + schema.minimum);
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    errors.push(path + ' 不能大于 ' + schema.maximum);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(path + ' 格式不匹配 ' + schema.pattern);
  }
}

/** 返回 [] 表示通过，否则返回字段错误列表。 */
export function validateSchema(schema, value, path = 'params') {
  const errors = [];
  if (!schema) return errors;
  if (schema.type === 'object') {
    if (valueType(value) !== 'object') {
      errors.push(path + ' 应为 object');
      return errors;
    }
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(props)) {
      if (value[key] !== undefined) checkValue(value[key], child, path + '.' + key, errors);
    }
  } else {
    checkValue(value, schema, path, errors);
  }
  return errors;
}

export function validateMethodParams(method, params) {
  const schema = METHOD_SCHEMAS[method] || GENERIC_SCHEMA;
  if (!schema) return [];
  return validateSchema(schema, params && typeof params === 'object' ? params : {}, 'params');
}
