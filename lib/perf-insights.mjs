// lib/perf-insights.mjs —— 把性能指标转成可执行的结论，而不是只报数字。
export function analyzePerformance(metrics = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const ttfb = Number(metrics.ttfb);
  const dcl = Number(metrics.domContentLoaded);
  const load = Number(metrics.load);
  const lcp = Number(metrics.lcp);
  const cls = Number(metrics.cls);
  const longCount = Number(metrics.longTasks && metrics.longTasks.count) || 0;
  const longMax = Number(metrics.longTasks && metrics.longTasks.maxMs) || 0;
  const bytes = Number(metrics.resources && metrics.resources.transferBytes) || 0;
  const resources = Number(metrics.resources && metrics.resources.count) || 0;

  if (ttfb > 800) add('warn', 'TTFB', 'TTFB ' + Math.round(ttfb) + 'ms，服务端/网络响应偏慢');
  if (dcl > 2000) add('warn', 'DCL', 'DOMContentLoaded ' + Math.round(dcl) + 'ms，脚本阻塞或资源过多');
  if (load > 3000) add('warn', 'LOAD', 'load ' + Math.round(load) + 'ms，首屏完成偏慢');
  if (lcp > 2500) add('warn', 'LCP', 'LCP ' + Math.round(lcp) + 'ms，最大内容绘制偏慢');
  if (cls > 0.1) add('warn', 'CLS', 'CLS ' + cls + '，布局有可见抖动');
  if (longMax > 50 || longCount >= 5) add('warn', 'LONG_TASK', '长任务 ' + longCount + ' 个，最长 ' + longMax + 'ms');
  if (bytes > 2 * 1024 * 1024) add('info', 'BYTES', '传输 ' + (bytes / 1024 / 1024).toFixed(1) + 'MiB，资源体积偏大');
  if (resources > 150) add('info', 'REQUESTS', '资源请求 ' + resources + ' 个，考虑合并/懒加载');
  if (!findings.length) add('ok', 'OK', '关键性能指标在阈值内');
  return findings;
}
