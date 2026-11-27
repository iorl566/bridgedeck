// fill 快路径规划、步骤证据、控件分类、读回字段与目标构造（从 interaction 拆出）。

/** HTML 日期/时间类 input：浏览器要求完整 value，不能用逐字符 insertText。 */
export const DATE_INPUT_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

/** 只能“点击/上传”而不能 fill 的控件类型。 */
export const NON_FILL_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'submit', 'reset', 'button', 'image']);

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

export function isDateInputType(inputType) {
  return DATE_INPUT_TYPES.has(lower(inputType));
}

/**
 * 控件类型判定（纯函数）：fill 的 1/2/3 步策略与实际派发路径都由它决定。
 * @returns {{kind:string, path:string, fillable:boolean, clearVia:string|null, reason:string}}
 */
export function classifyFillControl(facts = {}) {
  const input = facts && typeof facts === 'object' ? facts : {};
  const tag = lower(input.tag || input.tagName);
  const inputType = lower(input.inputType || input.type);
  const isContentEditable = input.isContentEditable === true;
  const role = lower(input.role);
  const textLike = input.textLike === true;
  if (isContentEditable || role === 'textbox' && tag !== 'input' && tag !== 'textarea') {
    return { kind: 'contenteditable', path: 'rich-text', fillable: true, clearVia: 'keyboard', reason: 'contenteditable' };
  }
  if (tag === 'select') {
    return { kind: 'select', path: 'page-select', fillable: true, clearVia: null, reason: 'select-control' };
  }
  if (tag === 'input' && isDateInputType(inputType)) {
    return { kind: 'date-control', path: 'native-value-setter', fillable: true, clearVia: null, reason: 'date-control' };
  }
  if (tag === 'input' && NON_FILL_INPUT_TYPES.has(inputType)) {
    return {
      kind: inputType === 'file' ? 'file-control' : 'check-control',
      path: inputType === 'file' ? 'upload' : 'click',
      fillable: false,
      clearVia: null,
      reason: 'not-fillable-' + inputType,
    };
  }
  if (textLike) {
    return {
      kind: tag === 'textarea' ? 'text-control' : (tag === 'input' ? 'text-control' : 'rich-text'),
      path: 'trusted-insert',
      fillable: true,
      clearVia: input.hadValue === true || tag === 'textarea' ? 'page-select' : 'page-select',
      reason: 'text-control',
    };
  }
  return { kind: 'programmatic', path: 'page-fill', fillable: true, clearVia: null, reason: 'programmatic-only' };
}

/** 每一步的“怎么执行”证据：调用方（fill-actions）按这些 via 真正派发。 */
function stepEvidence(steps, vias) {
  return steps.map((step, index) => ({ step, via: vias[index] || 'unknown' }));
}

/**
 * fill 快路径步骤规划（纯函数，浏览器夹具与扩展共用）。
 * 空且简单 input 只算 1 步 insertText；已有值 / 复杂控件（contenteditable 等）
 * 走 focus→clear→insert，最多 3 步；programmatic 控件（select/date 等）由页面库
 * 一次写入/选择，记为 focus→set-value→commit 3 步（select 的中间步是 match-option）。
 */
export function planFillSteps(facts = {}) {
  const input = facts && typeof facts === 'object' ? facts : {};
  const control = classifyFillControl({ ...input, textLike: input.textLike });
  const noClear = input.noClear === true;
  if (input.textLike !== true) {
    if (control.kind === 'select') {
      return {
        strategy: 'programmatic',
        steps: ['focus', 'match-option', 'commit'],
        step_count: 3,
        needs_clear: false,
        clear_via: null,
        insert_text_calls: 0,
        reason: 'select-control',
        kind: 'select',
        control_kind: 'select',
        path: 'page-select',
        step_evidence: stepEvidence(['focus', 'match-option', 'commit'], ['element-focus', 'page-lib:select', 'input+change']),
      };
    }
    const date = control.kind === 'date-control';
    return {
      strategy: 'programmatic',
      steps: ['focus', 'set-value', 'commit'],
      step_count: 3,
      needs_clear: false,
      clear_via: null,
      insert_text_calls: 0,
      reason: date ? 'date-control' : 'programmatic-only',
      kind: date ? 'date-control' : 'programmatic',
      control_kind: control.kind,
      path: date ? 'native-value-setter' : 'page-fill',
      step_evidence: stepEvidence(['focus', 'set-value', 'commit'], ['element-focus', 'native-value-setter', 'input+change']),
    };
  }
  const tag = lower(input.tag);
  const rich = control.kind === 'contenteditable' || input.isContentEditable === true || (tag !== '' && tag !== 'input' && tag !== 'textarea');
  const empty = input.hadValue === false && rich !== true;
  // kind 保持既有对外语义（rich-text/text-control）；更细的控件类型放 control_kind。
  const kind = rich ? 'rich-text' : 'text-control';
  const controlKind = control.kind;
  if (noClear) {
    return {
      strategy: 'fast',
      steps: ['focus', 'insert'],
      step_count: 2,
      needs_clear: false,
      clear_via: null,
      insert_text_calls: 1,
      reason: 'no-clear',
      kind,
      control_kind: controlKind,
      path: 'trusted-insert',
      step_evidence: stepEvidence(['focus', 'insert'], ['element-focus', 'cdp-insertText']),
    };
  }
  if (empty) {
    return {
      strategy: 'fast',
      steps: ['insert'],
      step_count: 1,
      needs_clear: false,
      clear_via: null,
      insert_text_calls: 1,
      reason: 'empty-simple-input',
      kind: 'text-control',
      control_kind: controlKind,
      path: 'trusted-insert',
      step_evidence: stepEvidence(['insert'], ['cdp-insertText']),
    };
  }
  return {
    strategy: 'fast',
    steps: ['focus', 'clear', 'insert'],
    step_count: 3,
    needs_clear: true,
    // 普通 input/textarea 的 clear 由 fill-focus 的 select() 完成；富文本只能键盘 Ctrl+A。
    clear_via: rich ? 'keyboard' : 'page-select',
    insert_text_calls: 1,
    reason: rich ? (controlKind === 'contenteditable' ? 'contenteditable' : 'rich-text') : 'existing-value',
    kind,
    control_kind: controlKind,
    path: 'trusted-insert',
    step_evidence: stepEvidence(
      ['focus', 'clear', 'insert'],
      ['element-focus', rich ? 'keyboard:Control+a' : 'page-select', 'cdp-insertText'],
    ),
  };
}

/**
 * 把规划中的步骤证据与运行时的实际结果合并：fill 返回的 fill_step_evidence
 * 每条都带 ok/detail，agent 可以据此判断“哪一步真的做了”。
 */
export function fillStepEvidence(plan, observed = {}) {
  const steps = plan && Array.isArray(plan.step_evidence) ? plan.step_evidence : [];
  const facts = observed && typeof observed === 'object' ? observed : {};
  return steps.map((item) => {
    const result = facts[item.step];
    const ok = result !== false && !(result && typeof result === 'object' && result.ok === false);
    return {
      step: item.step,
      via: item.via,
      ok,
      ...(result && typeof result === 'object' ? { detail: result } : {}),
      ...(result === false ? { reason: 'step-failed' } : {}),
    };
  });
}

/** 把快路径规划摊平成对外字段：步骤名/步数/清空方式/步骤证据/控件类型。 */
export function fillPlanFields(plan) {
  if (!plan || typeof plan !== 'object') return {};
  const steps = Array.isArray(plan.steps) ? plan.steps.slice() : [];
  return {
    fill_strategy: String(plan.strategy || 'fast'),
    fill_steps: steps,
    fill_step_count: Number.isInteger(plan.step_count) ? plan.step_count : steps.length,
    fill_needs_clear: plan.needs_clear === true,
    ...(plan.clear_via ? { fill_clear_via: String(plan.clear_via) } : {}),
    ...(plan.kind ? { fill_control_kind: String(plan.control_kind || plan.kind) } : {}),
    ...(plan.path ? { fill_path: String(plan.path) } : {}),
    ...(Array.isArray(plan.step_evidence) ? { fill_step_evidence: fillStepEvidence(plan, plan.observed) } : {}),
  };
}

export function fillVerifyFields(verified) {
  if (!verified) return {};
  const actualText = verified.value != null ? String(verified.value) : '';
  if (verified.sensitive === true) return { formatted: verified.formatted === true, matches: verified.matches === true, sensitive: true };
  return {
    actual_value: actualText.slice(0, 200),
    ...(actualText.length > 200 ? { actual_value_truncated: true } : {}),
    ...(typeof verified.expected_value === 'string' ? { expected_value: verified.expected_value.slice(0, 200) } : {}),
    formatted: verified.formatted === true,
    matches: verified.matches === true,
  };
}

export function fillVerifyTargets(params) {
  return params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : {});
}
