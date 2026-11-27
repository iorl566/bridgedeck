// tests/unit/mcp-prompts.test.mjs —— MCP prompts 声明/渲染/参数校验测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_DEFINITIONS,
  PROMPT_ERRORS,
  PROMPT_RESOURCE_HINTS,
  PromptError,
  auditPrompts,
  getPrompt,
  listPrompts,
  promptDefinition,
  promptEnumTable,
  sampleArguments,
  validatePromptArguments,
} from '../../mcp/prompts.mjs';

const EXPECTED_PROMPTS = [
  'browser_task_brief',
  'debug_investigation',
  'cooperation_handoff',
  'recipe_from_session',
  'page_action_plan',
  'har_analysis',
  'network_diagnosis',
  'longshot_recovery',
  'video_verify',
];

test('prompt 声明：9 个模板、名字 snake_case、参数声明完整', () => {
  const list = listPrompts();
  assert.equal(list.length, PROMPT_DEFINITIONS.length);
  assert.ok(list.length >= 9);
  assert.deepEqual(list.map((prompt) => prompt.name), EXPECTED_PROMPTS);
  for (const prompt of list) {
    assert.match(prompt.name, /^[a-z0-9_]+$/);
    assert.ok(prompt.description.length > 10);
    assert.ok(Array.isArray(prompt.arguments) && prompt.arguments.length > 0);
    for (const argument of prompt.arguments) {
      assert.equal(typeof argument.name, 'string');
      assert.equal(typeof argument.description, 'string');
      assert.equal(typeof argument.required, 'boolean');
      // MCP 声明字段最小集：enum 放在 _meta 里，不污染 arguments
      assert.equal('enum' in argument, false, prompt.name + '.' + argument.name);
    }
    const meta = prompt._meta['browser-bridge/prompt'];
    assert.equal(meta.name, prompt.name);
    assert.ok(Array.isArray(meta.tags) && meta.tags.length > 0);
    assert.ok(Array.isArray(meta.resources) && meta.resources.length > 0);
  }
  assert.deepEqual(auditPrompts(), { ok: true, errors: [], total: list.length, withEnums: 4 });
  // listPrompts 不返回渲染函数（可安全序列化给客户端）
  assert.equal(JSON.stringify(list).includes('render'), false);
});

test('渲染：必填参数进入文本，messages 结构符合 MCP', () => {
  const rendered = getPrompt('browser_task_brief', { task: '提交报销单', url: 'https://expense.test/', constraints: '只读' });
  assert.ok(rendered.description.includes('页面任务'));
  assert.equal(rendered.messages.length, 1);
  const message = rendered.messages[0];
  assert.equal(message.role, 'user');
  assert.equal(message.content.type, 'text');
  assert.ok(message.content.text.includes('提交报销单'));
  assert.ok(message.content.text.includes('https://expense.test/'));
  assert.ok(message.content.text.includes('只读'));
  assert.ok(message.content.text.includes('browser_observe'));
  assert.ok(message.content.text.includes('destructive'));
  assert.ok(message.content.text.includes('bridge://skill/SKILL.md'));
  // prompts/get 的 _meta 回显实际生效参数
  const meta = rendered._meta['browser-bridge/prompt'];
  assert.equal(meta.name, 'browser_task_brief');
  assert.deepEqual(meta.arguments.map((row) => row.name), ['task', 'url', 'constraints']);
  assert.equal(meta.arguments.find((row) => row.name === 'task').value, '提交报销单');
});

test('渲染：可选参数省略时给出默认语义', () => {
  const rendered = getPrompt('browser_task_brief', { task: '看看首页' });
  const text = rendered.messages[0].content.text;
  assert.ok(text.includes('沿用当前活动标签页'));
  assert.ok(text.includes('无额外约束'));
  const debug = getPrompt('debug_investigation', { symptom: '按钮点击无反应' });
  assert.ok(debug.messages[0].content.text.includes('按钮点击无反应'));
  assert.ok(debug.messages[0].content.text.includes('browser_debug_start'));
});

test('渲染：每个模板都能用样例参数渲染，且包含工具名/资源提示', () => {
  for (const prompt of listPrompts()) {
    const definition = promptDefinition(prompt.name);
    const args = sampleArguments(definition);
    const rendered = getPrompt(prompt.name, args);
    const text = rendered.messages[0].content.text;
    const anchors = Object.values(args).filter((value) => value !== 's1');
    assert.ok(anchors.some((anchor) => text.includes(anchor)), prompt.name + ' 未包含参数内容');
    assert.ok(text.length > 200, prompt.name + ' 渲染过短');
    assert.match(text, /browser_[a-z_]+/, prompt.name + ' 没有提到工具');
    assert.ok(text.includes('destructive'), prompt.name + ' 缺少分档/审批说明');
    assert.ok(text.includes('bridge://'), prompt.name + ' 缺少 resources 提示');
  }
});

test('新模板：HAR 分析渲染真实工具链与分页语义', () => {
  const rendered = getPrompt('har_analysis', { source: 'D:\\traces\\run.har', focus: 'errors' });
  const text = rendered.messages[0].content.text;
  assert.ok(text.includes('D:\\traces\\run.har'));
  assert.ok(text.includes('errors'));
  assert.ok(text.includes('browser_debug_har'));
  assert.ok(text.includes('browser_debug_har_import'));
  assert.ok(text.includes('browser_network_waterfall'));
  assert.ok(text.includes('browser_network_replay_har'));
  assert.ok(text.includes('requestId'));
  assert.ok(text.includes('cursor'));
  const fallback = getPrompt('har_analysis', { source: 'latest' });
  assert.ok(fallback.messages[0].content.text.includes('timings'));
});

test('新模板：网络诊断按协议层收敛，长截图按失败形态给恢复路径', () => {
  const network = getPrompt('network_diagnosis', { symptom: '资源 500', layer: 'cache' }).messages[0].content.text;
  assert.ok(network.includes('browser_debug_start'));
  assert.ok(network.includes('browser_rule_list'));
  assert.ok(network.includes('browser_debug_evidence'));
  assert.ok(network.includes('cache'));
  assert.ok(network.includes('browser_network_waterfall'));

  const longshot = getPrompt('longshot_recovery', { failure: 'stale' }).messages[0].content.text;
  assert.ok(longshot.includes('browser_longshot_recover'));
  assert.ok(longshot.includes('staleAttempts'));
  assert.ok(longshot.includes('DPR'));
  const gap = getPrompt('longshot_recovery', { failure: 'gap' }).messages[0].content.text;
  assert.ok(gap.includes('缺片'));
  assert.ok(gap.includes('manifest'));
  const crash = getPrompt('longshot_recovery', { failure: 'crash' }).messages[0].content.text;
  assert.ok(crash.includes('IndexedDB'));
  const dpi = getPrompt('longshot_recovery', { failure: 'dpi-budget' }).messages[0].content.text;
  assert.ok(dpi.includes('40000'));
});

test('新模板：视频校验覆盖时长/分片/sidx 与剪辑路径', () => {
  const text = getPrompt('video_verify', { recording: 'rec-42', checks: 'sidx' }).messages[0].content.text;
  assert.ok(text.includes('rec-42'));
  assert.ok(text.includes('sidx'));
  assert.ok(text.includes('browser_video_status'));
  assert.ok(text.includes('browser_video_info'));
  assert.ok(text.includes('browser_video_recover'));
  assert.ok(text.includes('browser_video_merge'));
  assert.ok(text.includes('video.verify'));
  const all = getPrompt('video_verify', { recording: 'rec-42' }).messages[0].content.text;
  assert.ok(all.includes('all（时长 / 帧完整性 / sidx-faststart）'));
});

test('枚举参数：合法值通过，越界值/未知枚举都按 E_ARG_ENUM 拒绝', () => {
  const table = promptEnumTable();
  assert.equal(table.length, 4);
  assert.deepEqual(table.map((row) => row.prompt), ['har_analysis', 'network_diagnosis', 'longshot_recovery', 'video_verify']);
  assert.deepEqual(table.find((row) => row.argument === 'failure').values, ['stale', 'gap', 'crash', 'dpi-budget']);
  for (const row of table) {
    for (const value of row.values) {
      const args = sampleArguments(promptDefinition(row.prompt));
      args[row.argument] = value;
      assert.doesNotThrow(() => getPrompt(row.prompt, args), row.prompt + '.' + row.argument + '=' + value);
    }
    const args = sampleArguments(promptDefinition(row.prompt));
    args[row.argument] = 'not-valid';
    assert.throws(() => getPrompt(row.prompt, args), (error) => {
      assert.ok(error instanceof PromptError);
      assert.equal(error.code, PROMPT_ERRORS.ENUM);
      assert.ok(error.message.includes(row.argument));
      return true;
    }, row.prompt + '.' + row.argument);
  }
  // 可选枚举不传时不应触发校验
  assert.doesNotThrow(() => getPrompt('har_analysis', { source: 'latest' }));
  assert.doesNotThrow(() => getPrompt('network_diagnosis', { symptom: 'x' }));
});

test('validatePromptArguments：返回结构化错误而不是抛异常', () => {
  assert.deepEqual(validatePromptArguments('browser_task_brief', { task: 'ok' }), { ok: true, errors: [] });
  const both = validatePromptArguments('browser_task_brief', { bogus: 'x' });
  assert.equal(both.ok, false);
  assert.equal(both.errors.length, 2);
  assert.equal(both.errors[0].code, PROMPT_ERRORS.UNKNOWN_ARG);
  assert.equal(both.errors[0].argument, 'bogus');
  assert.equal(both.errors[1].code, PROMPT_ERRORS.MISSING_ARG);
  assert.equal(both.errors[1].argument, 'task');
  assert.equal(validatePromptArguments('nope_prompt', {}).errors[0].code, PROMPT_ERRORS.NOT_FOUND);
  assert.equal(validatePromptArguments('longshot_recovery', { failure: 'nope' }).errors[0].code, PROMPT_ERRORS.ENUM);
  assert.equal(validatePromptArguments('browser_task_brief', 'not-an-object').errors[0].code, PROMPT_ERRORS.MISSING_ARG);
  assert.equal(validatePromptArguments('browser_task_brief', { task: '  ' }).errors[0].code, PROMPT_ERRORS.MISSING_ARG);
});

test('错误：未知 prompt / 缺必填 / 未声明参数', () => {
  assert.throws(() => getPrompt('nope_prompt', {}), (error) => {
    assert.ok(error instanceof PromptError);
    assert.equal(error.code, PROMPT_ERRORS.NOT_FOUND);
    return true;
  });
  assert.throws(() => getPrompt('debug_investigation', {}), (error) => {
    assert.equal(error.code, PROMPT_ERRORS.MISSING_ARG);
    assert.ok(error.message.includes('symptom'));
    return true;
  });
  const handoff = getPrompt('cooperation_handoff', { reason: '交接' });
  assert.ok(handoff.messages[0].content.text.includes('交接'));
  assert.throws(() => getPrompt('browser_task_brief', { task: '  ' }), (error) => error.code === PROMPT_ERRORS.MISSING_ARG);
  assert.throws(() => getPrompt('browser_task_brief', { task: 'x', unknown: 'y' }), (error) => error.code === PROMPT_ERRORS.UNKNOWN_ARG);
  assert.throws(() => getPrompt('browser_task_brief', 'not-an-object'), (error) => error.code === PROMPT_ERRORS.MISSING_ARG);
  assert.equal(promptDefinition('nope'), null);
  assert.ok(promptDefinition('browser_task_brief'));
  assert.deepEqual(PROMPT_RESOURCE_HINTS, ['bridge://skill/SKILL.md', 'bridge://observation/latest', 'bridge://debug/journal/latest']);
});
