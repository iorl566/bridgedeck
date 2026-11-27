// tools/quality/lib/render.mjs —— 门禁报告的三种渲染（text / json / markdown）。
//
// 渲染层是"可解释性可被 CLI 渲染"的落地点：失败 finding 在 text/markdown 里
// 必须同时出现 分类 / 重试 / 下一步 三个字段；缺少字段的 finding 不会进到这里
// （makeFinding 已拦截），但 audit 仍会再校验一次并给出 QUALITY_FINDING_UNEXPLAINED。
// 输出是确定性的：不含时间戳、耗时、绝对路径（由 result.sanitizeText 保证）。

import { CATEGORIES } from './taxonomy.mjs';

const RULE = '-'.repeat(72);

function categoryLabel(finding) {
  const category = finding && finding.category;
  if (!category) return '(未分类)';
  return CATEGORIES[category] ? CATEGORIES[category].label + '(' + category + ')' : String(category);
}

/** 渲染 finding 的失败解释块（CLI 的"下一步"提示等价物）。 */
export function renderExplanation(finding) {
  if (!finding || finding.ok === true) return '';
  return [
    '    分类：' + categoryLabel(finding),
    '    重试：' + finding.retry,
    '    下一步：' + finding.nextAction,
    '    详情：' + finding.detail,
  ].join('\n');
}

function renderGateSection(report, gate, lines) {
  const gateFindings = (report.findings || []).filter((finding) => finding.gate === gate.id);
  lines.push('[' + gate.id + '] ' + gate.title + ' — ' + (gate.ok ? 'PASS' : 'FAIL')
    + '（checks=' + gate.checks + ', blocking=' + gate.blocking + ', warnings=' + gate.warnings + '）');
  for (const finding of gateFindings) {
    if (finding.ok === true) {
      lines.push('  ✓ ' + finding.id + ' ' + finding.title);
      continue;
    }
    lines.push('  ✗ ' + finding.id + ' [' + finding.severity + '] ' + finding.title);
    lines.push(renderExplanation(finding));
  }
}

function renderConsumption(report, lines) {
  const runtime = Array.isArray(report.runtime) ? report.runtime : [];
  if (!runtime.length) return;
  lines.push('');
  lines.push('运行时消费点（门禁真实调用 → module:定义行 / gate:调用行）：');
  for (const entry of runtime) {
    lines.push('  - [' + entry.gate + '] ' + entry.symbol
      + ' @ ' + entry.location + ' ← ' + entry.consumedAt);
  }
}

/** 人类可读文本报告。 */
export function renderText(report) {
  const lines = [];
  const gate = report && report.gate ? report.gate : {};
  const summary = report && report.summary ? report.summary : {};
  lines.push('BridgeDeck 质量门禁报告（' + (report.schema || 'bb.quality/1') + '）');
  lines.push('模式=' + (gate.mode || 'check') + ' seed=' + gate.seed + ' repeats=' + gate.repeats
    + ' timeoutMs=' + gate.timeoutMs + ' gates=' + (report.gates || []).length);
  lines.push(RULE);
  const gates = Array.isArray(report.gates) ? report.gates : [];
  for (const entry of gates) {
    renderGateSection(report, entry, lines);
    lines.push('');
  }
  renderConsumption(report, lines);
  lines.push('');
  lines.push(RULE);
  const blocking = (report.findings || []).filter((finding) => finding.ok === false && finding.severity === 'blocking');
  if (blocking.length) {
    lines.push('阻断项（' + blocking.length + '）：');
    for (const finding of blocking) {
      lines.push('  - ' + finding.id + ' [' + categoryLabel(finding) + '] 重试=' + finding.retry + ' 下一步=' + finding.nextAction);
    }
  }
  lines.push('结论：' + (summary.verdict || 'FAIL')
    + '（checks=' + (summary.checks || 0)
    + ', passed=' + (summary.passed || 0)
    + ', blocking=' + (summary.blocking || 0)
    + ', warnings=' + (summary.warnings || 0) + '）');
  lines.push('digest=' + (summary.digest || '') + ' seed=' + (gate.seed || '') + ' repeats=' + (gate.repeats || ''));
  if (report.selftest && report.selftest.suggestion) {
    lines.push('selftest 建议：' + report.selftest.suggestion);
  }
  return lines.join('\n') + '\n';
}

/** CI/脚本用单行结论。 */
export function renderQuiet(report) {
  const gate = report && report.gate ? report.gate : {};
  const summary = report && report.summary ? report.summary : {};
  return 'quality verdict=' + (summary.verdict || 'FAIL')
    + ' gates=' + (report.gates || []).filter((entry) => entry.ok).length + '/' + (report.gates || []).length
    + ' checks=' + (summary.checks || 0)
    + ' blocking=' + (summary.blocking || 0)
    + ' warnings=' + (summary.warnings || 0)
    + ' seed=' + (gate.seed || '')
    + ' repeats=' + (gate.repeats || '')
    + ' digest=' + (summary.digest || '')
    + '\n';
}

/** 机器可读 JSON（--json，stdout 只许这一份文档）。 */
export function renderJson(report) {
  return JSON.stringify(report, null, 2) + '\n';
}

/** Markdown 报告（--out report.md）。 */
export function renderMarkdown(report) {
  const summary = report && report.summary ? report.summary : {};
  const gate = report && report.gate ? report.gate : {};
  const lines = [];
  lines.push('# BridgeDeck 质量门禁报告');
  lines.push('');
  lines.push('- 结论：**' + (summary.verdict || 'FAIL') + '**');
  lines.push('- schema：`' + (report.schema || '') + '`');
  lines.push('- seed：`' + gate.seed + '`，repeats：`' + gate.repeats + '`，timeoutMs：`' + gate.timeoutMs + '`');
  lines.push('- digest：`' + (summary.digest || '') + '`');
  lines.push('- checks=' + summary.checks + '，passed=' + summary.passed + '，blocking=' + summary.blocking + '，warnings=' + summary.warnings);
  lines.push('');
  lines.push('## 门禁');
  lines.push('');
  lines.push('| gate | 结果 | checks | blocking | warnings |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const entry of report.gates || []) {
    lines.push('| `' + entry.id + '` | ' + (entry.ok ? 'PASS' : 'FAIL') + ' | ' + entry.checks + ' | ' + entry.blocking + ' | ' + entry.warnings + ' |');
  }
  lines.push('');
  lines.push('## findings');
  lines.push('');
  lines.push('| id | 结果 | severity | 分类 | 重试 | 下一步 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const finding of report.findings || []) {
    const result = finding.ok ? '✓' : '✗';
    lines.push('| `' + finding.id + '` | ' + result + ' | ' + finding.severity + ' | '
      + (finding.ok ? '-' : categoryLabel(finding)) + ' | ' + (finding.retry || '-') + ' | '
      + (finding.ok ? '-' : String(finding.nextAction || '').replace(/\|/g, '\\|')) + ' |');
  }
  const runtime = Array.isArray(report.runtime) ? report.runtime : [];
  if (runtime.length) {
    lines.push('');
    lines.push('## 运行时消费点');
    lines.push('');
    lines.push('| gate | 符号 | 定义位置 | 调用位置 |');
    lines.push('| --- | --- | --- | --- |');
    for (const entry of runtime) {
      lines.push('| `' + entry.gate + '` | `' + entry.symbol + '` | `' + entry.location + '` | `' + entry.consumedAt + '` |');
    }
  }
  if (report.selftest && report.selftest.suggestion) {
    lines.push('');
    lines.push('> selftest 建议：' + report.selftest.suggestion);
  }
  return lines.join('\n') + '\n';
}

/** 按扩展名/显式模式选渲染器。 */
export function renderReport(report, mode = 'text') {
  if (mode === 'json') return renderJson(report);
  if (mode === 'quiet') return renderQuiet(report);
  if (mode === 'markdown' || mode === 'md') return renderMarkdown(report);
  return renderText(report);
}

/** 供 explainability gate 验证"渲染器能处理任意合法 finding"。 */
export function renderFindingLine(finding) {
  if (!finding) return '';
  if (finding.ok === true) return '✓ ' + finding.id;
  return '✗ ' + finding.id + ' 分类=' + categoryLabel(finding) + ' 重试=' + finding.retry + ' 下一步=' + finding.nextAction;
}
