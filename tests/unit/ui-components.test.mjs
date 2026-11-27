// tests/unit/ui-components.test.mjs —— UI 基础组件库（extension/ui/components）单测。
// 用最小假 DOM，验证结构/class/ARIA 契约；真实渲染由 tests/browser 与 UI 截图覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createButton, createCard, createSwitch, createField, createEmptyState, createSegmented } from '../../extension/ui/components/index.js';

function fakeDoc() {
  return {
    createElement(tag) {
      return {
        tagName: tag,
        attributes: {},
        children: [],
        textContent: '',
        className: '',
        listeners: {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
        getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null; },
        appendChild(node) { this.children.push(node); return node; },
        addEventListener(type, handler) { this.listeners[type] = handler; },
      };
    },
  };
}

test('UI components：按钮 variant/class/text/点击回调', () => {
  const doc = fakeDoc();
  let clicked = 0;
  const button = createButton({ doc, label: '保存', variant: 'primary', size: 'sm', onClick: () => { clicked += 1; } });
  assert.equal(button.tagName, 'button');
  assert.equal(button.className, 'btn primary sm');
  assert.equal(button.textContent, '保存');
  button.listeners.click();
  assert.equal(clicked, 1);
});

test('UI components：卡片标题与正文容器', () => {
  const doc = fakeDoc();
  const { node, body } = createCard({ doc, title: '连接设置' });
  assert.equal(node.className, 'card');
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].textContent, '连接设置');
  assert.equal(body.className, 'card-body');
});

test('UI components：开关 role/aria 与点击切换', () => {
  const doc = fakeDoc();
  let value = null;
  const { node } = createSwitch({ doc, label: '借用确认', checked: true, onChange: (next) => { value = next; } });
  assert.equal(node.getAttribute('role'), 'switch');
  assert.equal(node.getAttribute('aria-checked'), 'true');
  assert.equal(node.getAttribute('aria-label'), '借用确认');
  node.listeners.click();
  assert.equal(node.getAttribute('aria-checked'), 'false');
  assert.equal(value, false);
});

test('UI components：分段控件 items/选中态/setValue', () => {
  const doc = fakeDoc();
  const { node, setValue } = createSegmented({ doc, items: [{ value: 'local', label: '本机' }, { value: 'remote', label: '远程' }], value: 'local' });
  assert.equal(node.className, 'seg');
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].className, 'on');
  assert.equal(node.children[0].getAttribute('aria-selected'), 'true');
  assert.equal(node.children[1].getAttribute('aria-selected'), 'false');
  setValue('remote');
  assert.equal(node.children[1].className, 'on');
  assert.equal(node.children[1].getAttribute('aria-selected'), 'true');
});

test('UI components：字段与空态结构', () => {
  const doc = fakeDoc();
  const input = doc.createElement('input');
  const field = createField({ doc, label: '本机端口', control: input, hint: '留空恢复默认', htmlFor: 'daemonPort' });
  assert.equal(field.className, 'field');
  assert.equal(field.getAttribute('for'), 'daemonPort');
  assert.equal(field.children.length, 3);
  const empty = createEmptyState({ doc, title: '还没有任务记录', hint: '执行一次操作后会显示在这里' });
  assert.equal(empty.className, 'bd-empty state-block');
  assert.equal(empty.getAttribute('role'), 'status');
  assert.equal(empty.children.length, 2);
});

test('UI components：没有 document 且未注入 doc 时明确报错', () => {
  assert.throws(() => createButton({ label: 'x' }), /createElement 不可用/);
});
