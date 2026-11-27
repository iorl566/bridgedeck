// tests/support/vom-fixture-pages.ts —— VOM 差分夹具页（真实 DOM 事实源）。
//
// 这些页面用 fake-dom 构造，再由 rich.ts 的同一套 DOM 流程抽取成 facts JSON
// （tests/fixtures/vom-facts/*.json）。夹具覆盖：
// - landmark / form / table 三类上下文锚点与嵌套链；
// - aria-labelledby / aria-describedby / aria-controls / aria-owns / aria-errormessage；
// - label[for] 关联、form 归属、dialog 内关闭按钮、组合控件（combobox→listbox→option）；
// - affordance 全谱：upload/type/toggle/select/drag/scroll/dismiss/hover/activate/focus；
// - 跨 frame 子图（iframe owner 节点 + frame 子图，用于 relations/context 的 frame 分支）。
//
// 生成命令（facts JSON 变更后重跑）：
//   $env:PATH='D:\tools\node;' + $env:PATH
//   node apps/extension/tests/support/write-vom-fixtures.ts
//
// 单测 `tests/vom-facts.test.ts` 会断言「重新抽取 == 已提交夹具」，防止夹具与实现漂移。

import type { FakeElementSpec } from './fake-dom.ts';
import type { VomFactsFrame } from '../../src/content/vom-facts.ts';

export interface VomFixturePage {
  /** 夹具文件名（tests/fixtures/vom-facts/<name>.json）。 */
  name: string;
  title: string;
  url: string;
  elements: FakeElementSpec[];
  frames?: VomFactsFrame[];
}

function rect(left: number, top: number, width: number, height: number): { left: number; top: number; width: number; height: number } {
  return { left, top, width, height };
}

/** 表单/上下文/关系/affordance 综合页。 */
function basicFormPage(): VomFixturePage {
  return {
    name: 'basic-form',
    title: '登录表单夹具',
    url: 'https://example.test/basic-form.html',
    elements: [
      { tag: 'h1', text: '登录表单夹具', rect: rect(0, 0, 800, 40) },
      {
        tag: 'main',
        id: 'app',
        attrs: { role: 'main', 'aria-label': '主内容' },
        rect: rect(0, 40, 800, 720),
        children: [
          {
            tag: 'form',
            id: 'login-form',
            attrs: { 'aria-label': '登录' },
            rect: rect(0, 50, 800, 420),
            children: [
              { tag: 'label', id: 'user-label', attrs: { for: 'username' }, text: '用户名', rect: rect(10, 60, 80, 20) },
              {
                tag: 'input',
                id: 'username',
                type: 'text',
                attrs: {
                  placeholder: '请输入用户名',
                  'aria-describedby': 'user-hint',
                  'aria-errormessage': 'user-error',
                  'aria-invalid': 'true',
                },
                rect: rect(100, 60, 220, 28),
              },
              { tag: 'p', id: 'user-hint', attrs: { role: 'note' }, text: '至少 8 位', rect: rect(100, 90, 220, 18) },
              { tag: 'p', id: 'user-error', attrs: { role: 'alert' }, text: '用户名已存在', rect: rect(100, 110, 220, 18) },
              { tag: 'button', id: 'submit', type: 'button', text: '提交', rect: rect(100, 140, 100, 32) },
              {
                tag: 'input',
                id: 'avatar',
                type: 'file',
                attrs: { 'aria-label': '上传头像' },
                rect: rect(100, 180, 200, 28),
              },
              {
                tag: 'div',
                id: 'city-box',
                rect: rect(10, 220, 700, 90),
                children: [
                  {
                    tag: 'input',
                    id: 'city',
                    attrs: {
                      role: 'combobox',
                      'aria-label': '城市',
                      'aria-haspopup': 'listbox',
                      'aria-controls': 'city-list',
                      'aria-expanded': 'false',
                    },
                    rect: rect(100, 220, 200, 28),
                  },
                  {
                    tag: 'ul',
                    id: 'city-list',
                    attrs: { role: 'listbox', 'aria-label': '城市列表' },
                    rect: rect(100, 250, 200, 60),
                    children: [
                      { tag: 'li', id: 'beijing', attrs: { role: 'option' }, text: '北京', rect: rect(100, 250, 200, 28) },
                      { tag: 'li', id: 'shanghai', attrs: { role: 'option' }, text: '上海', rect: rect(100, 278, 200, 28) },
                    ],
                  },
                ],
              },
              {
                tag: 'input',
                id: 'agree',
                type: 'checkbox',
                attrs: { 'aria-label': '同意条款' },
                rect: rect(100, 320, 20, 20),
              },
              {
                tag: 'div',
                id: 'slider',
                attrs: { role: 'slider', 'aria-label': '音量', draggable: 'true', tabindex: '0' },
                style: { cursor: 'pointer' },
                rect: rect(140, 320, 160, 20),
              },
              { tag: 'button', id: 'close-btn', type: 'button', text: '关闭', rect: rect(320, 320, 80, 28) },
            ],
          },
          {
            tag: 'div',
            id: 'profile-dialog',
            attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '个人资料' },
            rect: rect(120, 480, 420, 200),
            children: [
              { tag: 'button', id: 'dialog-close', type: 'button', text: 'Close', rect: rect(500, 490, 30, 30) },
              { tag: 'a', id: 'dialog-home', attrs: { href: '/home' }, text: '首页', rect: rect(140, 500, 80, 24) },
            ],
          },
          {
            tag: 'div',
            id: 'scroll-box',
            attrs: { role: 'region', 'aria-label': '滚动区' },
            style: { overflowY: 'auto' },
            rect: rect(0, 690, 300, 60),
            scrollHeight: 480,
          },
          {
            tag: 'table',
            id: 'people',
            attrs: { 'aria-label': '用户表' },
            rect: rect(420, 480, 360, 200),
            children: [
              {
                tag: 'thead',
                children: [{
                  tag: 'tr',
                  children: [
                    { tag: 'th', id: 'people-name', text: '姓名', rect: rect(420, 480, 120, 24) },
                    { tag: 'th', id: 'people-city', text: '城市', rect: rect(540, 480, 120, 24) },
                  ],
                }],
              },
              {
                tag: 'tbody',
                children: [{
                  tag: 'tr',
                  children: [
                    { tag: 'td', id: 'people-1-name', text: '张三', rect: rect(420, 510, 120, 24) },
                    { tag: 'td', id: 'people-1-city', text: '北京', rect: rect(540, 510, 120, 24) },
                  ],
                }],
              },
            ],
          },
          {
            tag: 'img',
            id: 'logo',
            attrs: { alt: '公司 Logo', title: '公司标志' },
            rect: rect(700, 60, 40, 40),
          },
          {
            tag: 'div',
            id: 'toggle',
            attrs: { role: 'switch', 'aria-label': '开关', 'aria-pressed': 'true' },
            rect: rect(360, 320, 60, 28),
          },
          {
            tag: 'div',
            id: 'drag-handle',
            attrs: { 'data-drag-handle': '', 'aria-label': '拖拽手柄' },
            rect: rect(600, 320, 40, 28),
          },
          {
            tag: 'div',
            id: 'menu-trigger',
            attrs: { role: 'menuitem', 'aria-label': '更多操作', 'aria-haspopup': 'menu' },
            rect: rect(660, 320, 100, 28),
          },
        ],
      },
    ],
  };
}

/** 应用壳页：多个 landmark + 表单/表格同页，验证父子组与上下文链。 */
function appShellPage(): VomFixturePage {
  return {
    name: 'app-shell',
    title: '应用壳夹具',
    url: 'https://example.test/app-shell.html',
    elements: [
      {
        tag: 'div',
        id: 'shell',
        rect: rect(0, 0, 1280, 800),
        children: [
          {
            tag: 'header',
            id: 'topbar',
            attrs: { 'aria-label': '页头' },
            rect: rect(0, 0, 1280, 60),
            children: [{ tag: 'button', id: 'sign-in', text: '登录', rect: rect(1100, 10, 100, 32) }],
          },
          {
            tag: 'nav',
            id: 'sidebar',
            attrs: { 'aria-label': '导航' },
            rect: rect(0, 60, 200, 740),
            children: [
              { tag: 'a', id: 'nav-home', attrs: { href: '/' }, text: '首页', rect: rect(10, 80, 160, 28) },
              { tag: 'a', id: 'nav-orders', attrs: { href: '/orders' }, text: '订单', rect: rect(10, 120, 160, 28) },
            ],
          },
          {
            tag: 'main',
            id: 'content',
            attrs: { 'aria-label': '主体' },
            rect: rect(200, 60, 1080, 740),
            children: [
              {
                tag: 'section',
                id: 'orders-section',
                attrs: { 'aria-label': '订单区' },
                rect: rect(200, 60, 1080, 400),
                children: [
                  {
                    tag: 'form',
                    id: 'filter-form',
                    attrs: { 'aria-label': '筛选' },
                    rect: rect(200, 60, 1080, 80),
                    children: [
                      { tag: 'label', id: 'filter-label', attrs: { for: 'filter-kw' }, text: '关键词', rect: rect(210, 70, 80, 20) },
                      { tag: 'input', id: 'filter-kw', type: 'search', rect: rect(300, 70, 240, 28) },
                      { tag: 'button', id: 'filter-apply', type: 'button', text: '筛选', rect: rect(560, 70, 80, 28) },
                    ],
                  },
                  {
                    tag: 'table',
                    id: 'orders-table',
                    attrs: { 'aria-label': '订单表' },
                    rect: rect(200, 150, 900, 300),
                    children: [
                      {
                        tag: 'thead',
                        children: [{
                          tag: 'tr',
                          children: [
                            { tag: 'th', id: 'orders-id', text: '订单号', rect: rect(200, 150, 200, 24) },
                            { tag: 'th', id: 'orders-amount', text: '金额', rect: rect(400, 150, 200, 24) },
                          ],
                        }],
                      },
                      {
                        tag: 'tbody',
                        children: [
                          { tag: 'tr', children: [
                            { tag: 'td', id: 'order-1', attrs: { role: 'cell' }, text: 'A-001', rect: rect(200, 180, 200, 24) },
                            { tag: 'td', id: 'order-1-amount', attrs: { role: 'cell' }, text: '¥ 100', rect: rect(400, 180, 200, 24) },
                          ] },
                          { tag: 'tr', children: [
                            { tag: 'td', id: 'order-2', attrs: { role: 'cell' }, text: 'A-002', rect: rect(200, 210, 200, 24) },
                            { tag: 'td', id: 'order-2-amount', attrs: { role: 'cell' }, text: '¥ 200', rect: rect(400, 210, 200, 24) },
                          ] },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                tag: 'div',
                id: 'detail-pane',
                attrs: { role: 'region', 'aria-labelledby': 'detail-title', 'aria-describedby': 'detail-hint' },
                rect: rect(200, 480, 600, 300),
                children: [
                  { tag: 'h2', id: 'detail-title', text: '订单详情', rect: rect(210, 490, 200, 28) },
                  { tag: 'p', id: 'detail-hint', attrs: { role: 'note' }, text: '点击行查看详情', rect: rect(210, 520, 300, 20) },
                  {
                    tag: 'div',
                    id: 'detail-tabs',
                    attrs: { role: 'tablist', 'aria-label': '详情页签' },
                    rect: rect(210, 550, 400, 32),
                    children: [
                      { tag: 'button', id: 'tab-info', attrs: { role: 'tab', 'aria-controls': 'panel-info' }, text: '信息', rect: rect(210, 550, 80, 28) },
                      { tag: 'button', id: 'tab-log', attrs: { role: 'tab', 'aria-controls': 'panel-log' }, text: '日志', rect: rect(300, 550, 80, 28) },
                    ],
                  },
                  { tag: 'div', id: 'panel-info', attrs: { role: 'tabpanel', 'aria-label': '信息' }, rect: rect(210, 590, 400, 120) },
                  { tag: 'div', id: 'panel-log', attrs: { role: 'tabpanel', 'aria-label': '日志' }, rect: rect(210, 590, 400, 120) },
                ],
              },
            ],
          },
          {
            tag: 'footer',
            id: 'page-footer',
            attrs: { 'aria-label': '页脚' },
            rect: rect(0, 760, 1280, 40),
            children: [{ tag: 'p', text: 'BridgeDeck 夹具页脚', rect: rect(10, 770, 300, 20) }],
          },
        ],
      },
    ],
  };
}

/** 跨 frame 页：iframe owner 节点 + frame 子图（frame 关系/上下文 parity 输入）。 */
function framesPage(): VomFixturePage {
  return {
    name: 'frames',
    title: '跨 frame 夹具',
    url: 'https://example.test/frames.html',
    elements: [
      {
        tag: 'main',
        id: 'frames-root',
        attrs: { role: 'main', 'aria-label': '跨 frame 主体' },
        rect: rect(0, 0, 1200, 700),
        children: [
          {
            tag: 'iframe',
            id: 'frame-x',
            attrs: { src: 'frame-x.html', title: '跨源子帧' },
            rect: rect(20, 60, 500, 400),
          },
          {
            tag: 'iframe',
            id: 'frame-nested',
            attrs: { src: 'nested-cross.html', title: '嵌套子帧' },
            rect: rect(540, 60, 500, 400),
          },
          { tag: 'button', id: 'frames-submit', type: 'button', text: '主帧按钮', rect: rect(20, 500, 120, 32) },
        ],
      },
    ],
    frames: [
      {
        frameId: 0,
        url: 'https://example.test/frames.html',
        parentFrameId: null,
        ownerNodeId: null,
        graph: null,
      },
      {
        frameId: 5,
        url: 'https://example.test/frame-x.html',
        parentFrameId: 0,
        ownerNodeId: 'frame-x',
        graph: {
          available: true,
          nodes: [
            { id: 'frame:5', role: 'frame', tag: 'iframe', name: 'frame-x', domId: null, parentId: 'frame-x' },
            { id: 'f5:root', role: 'region', tag: 'main', name: '子帧内容', domId: 'f5-root', parentId: 'frame:5' },
            { id: 'f5:btn', role: 'button', tag: 'button', name: '子帧按钮', domId: 'f5-btn', parentId: 'f5:root' },
          ],
          edges: [
            { type: 'frame', from: 'frame:5', to: 'f5:root' },
            { type: 'child', from: 'f5:root', to: 'f5:btn' },
          ],
          roots: ['f5:root'],
          truncated: false,
        },
      },
      {
        frameId: 9,
        url: 'https://example.test/nested-frame.html',
        parentFrameId: 5,
        ownerNodeId: 'f5:nested',
        graph: {
          available: true,
          nodes: [
            { id: 'frame:9', role: 'frame', tag: 'iframe', name: 'nested', domId: null, parentId: 'f5:nested' },
            { id: 'f9:text', role: 'textbox', tag: 'input', name: '嵌套输入', domId: 'f9-text', parentId: 'frame:9' },
          ],
          edges: [{ type: 'frame', from: 'frame:9', to: 'f9:text' }],
          roots: ['f9:text'],
          truncated: false,
        },
      },
    ],
  };
}

/** 全部夹具页（顺序稳定：文件名即 name）。 */
export function vomFixturePages(): VomFixturePage[] {
  return [basicFormPage(), appShellPage(), framesPage()];
}
