// ui/views/timeline-view.js —— 时间线/瀑布图的纯视图模型（无 DOM，可在 Node 单测）。
//
// 输入是数据 + 视图状态，输出是 lib/render.js 的描述树 + aria 文本。页面只调用
// `buildTimelineView(...)`，再 `mount(container, tree)` 挂载；交互（点击/键盘）通过
// `onBar(index)` 回调注册到描述里，由 lib/dom.js 转成真实 addEventListener。
//
// 消费点：extension/ui/debug.js（请求瀑布图）、extension/ui/audit.js（任务时间线）、
//         extension/ui/ops.js（事件序列）、extension/ui/record.js（录制分布）。

import { formatDuration, formatTimestamp } from '../lib/format.js';
import { formatLabel } from '../lib/labels.js';
import { buildTimelineModel, spanAriaParts, layoutSpans, sequenceLayout } from '../lib/timeline.js';
import { h, text, stateBlock, timelineBar, timelineTick, withClass } from '../lib/render.js';

function toneFor(index) {
  const tones = ['tone-a', 'tone-b', 'tone-c', 'tone-d'];
  return tones[index % tones.length];
}

/**
 * 构建时间线视图。
 * @param {{spans:Array, width?:number, lang?:string, view?:string, zoom?:number, pan?:number,
 *   emptyText?:string, onBar?:(index:number)=>void, onTick?:(index:number)=>void, title?:string}} input
 */
export function buildTimelineView(input = {}) {
  const lang = input.lang || 'zh';
  const spans = Array.isArray(input.spans) ? input.spans : [];
  const model = buildTimelineModel({
    spans,
    width: input.width,
    zoom: input.zoom,
    pan: input.pan,
    view: input.view,
    laneHeight: input.laneHeight,
    tickCount: input.tickCount,
  });
  if (model.empty) {
    return {
      model,
      empty: true,
      tree: stateBlock({ kind: 'empty', message: input.emptyText || formatLabel('timeline.empty', {}, lang) }),
      ariaLabel: formatLabel('a11y.empty', {}, lang),
    };
  }
  const children = [];
  if (input.title) children.push(h('h3', { class: 'tl-title' }, input.title));
  // 刻度尺
  const ticks = h('div', { class: 'tl-ticks', 'aria-hidden': 'true' }, model.ticks.map((tick) => {
    const x = model.width > 0 ? ((tick.value - model.domain.min) / Math.max(1e-6, model.domain.max - model.domain.min)) * model.width : 0;
    return timelineTick({ x, label: tick.label });
  }));
  children.push(ticks);
  // 轨道
  const track = h('div', { class: 'tl-track', style: { 'block-size': Math.max(1, model.totalHeight) + 'px' } },
    model.spans.map((span, index) => {
      const parts = spanAriaParts(span);
      const label = formatLabel('timeline.bar', {
        label: parts.label || String(index + 1),
        start: parts.start,
        duration: parts.duration,
      }, lang);
      const bar = timelineBar({
        x: span.x,
        y: span.y,
        width: span.width,
        height: span.height,
        label,
        tone: toneFor(span.lane || 0),
        on: input.onBar ? { click: () => input.onBar(index) } : null,
      });
      bar.attrs['data-index'] = String(index);
      bar.attrs.tabindex = index === 0 ? '0' : '-1';
      return bar;
    }));
  children.push(track);
  const summary = formatLabel('timeline.overview', {
    count: model.summary.count,
    span: formatDuration(model.summary.span),
  }, lang);
  const tree = h('div', { class: 'tl-root', role: 'group', 'aria-label': summary }, children);
  return {
    model,
    empty: false,
    tree,
    ariaLabel: summary,
    summaryLine: formatLabel('timeline.span', { span: formatDuration(model.summary.span) }, lang),
  };
}

/**
 * 等宽序列视图（ops 事件步骤）：每个事件一格，序号 + 摘要。
 * @param {{items:Array<{label:string, at?:number}>, width?:number, lang?:string, onStep?:(index:number)=>void}} input
 */
export function buildSequenceView(input = {}) {
  const lang = input.lang || 'zh';
  const items = Array.isArray(input.items) ? input.items : [];
  const cells = sequenceLayout(items.length, { width: input.width });
  if (!items.length) {
    return {
      empty: true,
      tree: stateBlock({ kind: 'empty', message: input.emptyText || formatLabel('timeline.empty', {}, lang) }),
      count: 0,
    };
  }
  const tree = h('div', { class: 'tl-sequence', role: 'list', 'aria-label': formatLabel('a11y.list', { count: items.length }, lang) },
    items.map((item, index) => {
      const label = String(item && item.label !== undefined ? item.label : '');
      const when = item && item.at !== undefined ? formatTimestamp(item.at) : '';
      const cell = sequenceCell({
        index,
        label,
        when,
        x: cells[index] ? cells[index].x : 0,
        width: cells[index] ? cells[index].width : 0,
        on: input.onStep ? { click: () => input.onStep(index) } : null,
      });
      return cell;
    }));
  return { empty: false, tree, count: items.length };
}

function sequenceCell({ index, label, when, x, width, on }) {
  const node = h('button', {
    type: 'button',
    class: 'tl-step',
    role: 'listitem',
    'aria-label': label + (when ? ' · ' + when : ''),
    'data-index': String(index),
    style: { insetInlineStart: Math.round(x) + 'px', inlineSize: Math.max(2, Math.round(width)) + 'px' },
  }, [text(String(index + 1))]);
  if (on) node.on = on;
  return node;
}

/**
 * 时间线缩放工具栏描述（页面把它塞进 toolbar）。
 * @param {{lang?:string, onZoomIn?:Function, onZoomOut?:Function, onReset?:Function, zoom?:number}} input
 */
export function buildTimelineControls(input = {}) {
  const lang = input.lang || 'zh';
  const make = (key, action, extra) => {
    const node = h('button', { type: 'button', class: 'btn' + (extra ? ' ' + extra : ''), 'aria-label': formatLabel(key, {}, lang) }, formatLabel(key, {}, lang));
    if (action) node.on = { click: action };
    return node;
  };
  return [
    make('timeline.zoomOut', input.onZoomOut),
    make('timeline.zoomIn', input.onZoomIn),
    make('timeline.reset', input.onReset),
  ];
}

/**
 * 单条 span 的详情描述（点击时间线柱子后展示）。
 * @param {{span:object, lang?:string, extra?:Array<[string,string]>}} input
 */
export function buildSpanDetail({ span, lang = 'zh', extra = [] } = {}) {
  if (!span) return stateBlock({ kind: 'empty', message: formatLabel('state.empty', {}, lang) });
  const parts = spanAriaParts(span);
  const rows = [
    ['timeline.bar', formatLabel('timeline.bar', { label: parts.label, start: parts.start, duration: parts.duration }, lang)],
    ...extra,
  ];
  return h('div', { class: 'kv-inline', role: 'group', 'aria-label': parts.label || 'span' },
    rows.map(([key, value]) => withClass(h('span', {}, [String(value)]), 'kv-item')));
}

/** 用已有布局（页面自己算过）直接出树；保留给需要自定义宽度的调用方。 */
export function buildTimelineFromLayout(placements, { lang = 'zh' } = {}) {
  return h('div', { class: 'tl-track' }, placements.map((span) => timelineBar({
    x: span.x,
    y: span.y,
    width: span.width,
    height: span.height,
    label: formatLabel('timeline.bar', spanAriaParts(span), lang),
    tone: toneFor(span.lane || 0),
  })));
}

/** 布局辅助：页面在 resize 时重新算（返回纯数据，不改 DOM）。 */
export function relayout(spans, options = {}) {
  return layoutSpans(spans, options);
}
