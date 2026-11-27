import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecipeParamError,
  collectRecipeParamNames,
  normalizeParamDeclarations,
  parseParamPairs,
  recipeParamFingerprint,
  resolveRecipeParams,
  substituteRecipeSteps,
  substituteTypedParams,
} from '../../lib/recipe-params.mjs';

test('参数声明：数组/对象两种写法、默认类型、重名与非法名报错', () => {
  const fromArray = normalizeParamDeclarations([
    { name: 'city', type: 'string', default: '上海' },
    'size',
    { name: 'count', type: 'integer', min: 1, max: 5 },
  ]);
  assert.deepEqual(fromArray.map((item) => item.name), ['city', 'size', 'count']);
  assert.equal(fromArray[1].type, 'string');
  assert.equal(fromArray[2].min, 1);
  const fromObject = normalizeParamDeclarations({ city: { type: 'enum', enum: ['a', 'b'] }, flag: 'boolean' });
  assert.deepEqual(fromObject.map((item) => item.name), ['city', 'flag']);
  assert.equal(fromObject[1].type, 'boolean');
  assert.throws(() => normalizeParamDeclarations([{ name: '9bad' }]), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeParamDeclarations(['dup', 'dup']), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => normalizeParamDeclarations([{ name: 'e', type: 'enum' }]), (error) => error.code === 'E_ARG_TYPE');
  assert.throws(() => normalizeParamDeclarations([{ name: 'p', pattern: '[' }]), (error) => error.code === 'E_ARG_TYPE');
});

test('模板参数收集：嵌套 if/loop 里的占位符都能找到', () => {
  const names = collectRecipeParamNames([
    { method: 'navigate', params: { url: 'https://x/{{city}}' } },
    { type: 'loop', times: 2, steps: [{ method: 'fill', params: { value: '{{size}}' } }] },
    { type: 'if', when: { urlIncludes: '{{flag}}' }, then: [{ method: 'click', params: { selector: '{{selector}}' } }] },
  ]);
  assert.deepEqual(names.sort(), ['city', 'flag', 'selector', 'size']);
});

test('参数解析：默认值 + 类型强制 + 必需参数', () => {
  const declarations = [
    { name: 'city', type: 'string', default: '上海' },
    { name: 'count', type: 'integer', required: true },
    { name: 'fast', type: 'boolean', default: 'true' },
    { name: 'size', type: 'enum', enum: ['S', 'L'], default: 'S' },
  ];
  const resolved = resolveRecipeParams(declarations, { count: '3' });
  assert.equal(resolved.errors.length, 0);
  assert.deepEqual(resolved.values, { count: 3, city: '上海', fast: true, size: 'S' });
  assert.deepEqual(resolved.usedDefaults.sort(), ['city', 'fast', 'size']);
  assert.deepEqual(resolved.warnings, []);

  const missing = resolveRecipeParams(declarations, {});
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /缺少必需参数 count/);
});

test('参数类型错误：数字/整数/布尔/枚举/pattern/min/max/json', () => {
  const resolve = (declaration, value) => resolveRecipeParams([declaration], { [declaration.name]: value });
  assert.match(resolve({ name: 'n', type: 'number' }, 'abc').errors[0], /需要数字/);
  assert.match(resolve({ name: 'n', type: 'integer' }, '1.5').errors[0], /需要整数/);
  assert.match(resolve({ name: 'b', type: 'boolean' }, 'maybe').errors[0], /需要布尔值/);
  assert.match(resolve({ name: 'e', type: 'enum', enum: ['a'] }, 'b').errors[0], /只能是 a/);
  assert.match(resolve({ name: 'p', pattern: '^x' }, 'y').errors[0], /不符合 pattern/);
  assert.match(resolve({ name: 'm', type: 'number', min: 1 }, '0').errors[0], /不能小于 1/);
  assert.match(resolve({ name: 'm', type: 'number', max: 1 }, '2').errors[0], /不能大于 1/);
  assert.match(resolve({ name: 'j', type: 'json' }, '{nope').errors[0], /需要 JSON/);
  const json = resolve({ name: 'j', type: 'json' }, '{"a":1}');
  assert.deepEqual(json.values.j, { a: 1 });
});

test('未声明参数给警告；secret 打码；指纹稳定', () => {
  const resolved = resolveRecipeParams([{ name: 'token', type: 'string', secret: true }], { token: 'abcdef', extra: '1' }, { templateNames: ['token'] });
  assert.equal(resolved.errors.length, 0);
  assert.equal(resolved.values.token, 'abcdef');
  assert.equal(resolved.redacted.token, 'ab***ef');
  assert.ok(resolved.warnings.some((line) => line.includes('extra')));
  assert.equal(recipeParamFingerprint({ a: 1, b: 'x' }), recipeParamFingerprint({ b: 'x', a: 1 }));
  assert.notEqual(recipeParamFingerprint({ a: 1 }), recipeParamFingerprint({ a: 2 }));
  assert.match(recipeParamFingerprint({ a: 1 }), /^p[0-9a-f]{8}$/);
});

test('类型保持替换：整串占位符返回原类型，嵌套结构递归替换', () => {
  const params = { count: 3, flag: false, data: { a: 1 }, name: '张三' };
  assert.equal(substituteTypedParams('{{count}}', params), 3);
  assert.equal(substituteTypedParams('{{flag}}', params), false);
  assert.deepEqual(substituteTypedParams('{{data}}', params), { a: 1 });
  assert.equal(substituteTypedParams('hi {{name}} #{{count}}', params), 'hi 张三 #3');
  assert.deepEqual(substituteTypedParams({ list: ['{{count}}', '{{name}}'] }, params), { list: [3, '张三'] });
  assert.throws(() => substituteTypedParams('{{missing}}', params), (error) => error.code === 'E_BAD_ARG');
});

test('整份步骤替换覆盖 params/when/expect/reason 与嵌套块', () => {
  const steps = substituteRecipeSteps([
    { method: 'navigate', params: { url: 'https://x/{{city}}' } },
    { type: 'if', when: { urlIncludes: '{{city}}' }, then: [{ method: 'click', params: { selector: '#{{city}}' }, expect: { urlIncludes: '{{city}}' } }] },
    { type: 'human', reason: '人工确认 {{city}}' },
    { type: 'loop', times: 2, steps: [{ method: 'fill', params: { value: '{{city}}' } }] },
  ], { city: '上海' });
  assert.equal(steps[0].params.url, 'https://x/上海');
  assert.equal(steps[1].when.urlIncludes, '上海');
  assert.equal(steps[1].then[0].expect.urlIncludes, '上海');
  assert.equal(steps[2].reason, '人工确认 上海');
  assert.equal(steps[3].steps[0].params.value, '上海');
});

test('--param k=v 解析保持 v1 错误文案', () => {
  assert.deepEqual(parseParamPairs(['a=1', 'b=x=y']), { a: '1', b: 'x=y' });
  assert.deepEqual(parseParamPairs(undefined), {});
  assert.throws(() => parseParamPairs(['nokey']), (error) => error instanceof RecipeParamError && /--param 需要 key=value/.test(error.message));
  assert.throws(() => parseParamPairs(['9x=1']), (error) => /key 不合法/.test(error.message));
});
