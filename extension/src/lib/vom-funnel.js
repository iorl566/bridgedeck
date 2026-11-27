// VOM 漏斗摘要：把页面内阶段计数转成可读的保留率/丢弃原因。
//
// 兼容层：保留既有 `droppedReasons:[{stage,count}]` 字段（历史消费方按 stage 名读取），
// 同时输出显式六阶段 `stages:[{name,input,output,dropped,dropReasons,ms}]`（lib/vom-capture.js），
// 阶段名固定 collect→resolve→filter→enrich→rank→emit，供 observe 诊断与 capture 报告复用。
import { buildCaptureReport, captureStagesFromPageStages, summarizeCaptureReport } from './vom-capture.js';

export function summarizeVomFunnel(stages = {}) {
  const count = (key) => Math.max(0, Number(stages[key]) || 0);
  const collected = count('collected') || count('visited');
  const emitted = count('emitted');
  const known = count('skippedTag') + count('hidden') + count('stealth') + count('empty') + count('deduped');
  const reasons = [
    { stage: 'skippedTag', count: count('skippedTag') },
    { stage: 'hidden', count: count('hidden') },
    { stage: 'stealth', count: count('stealth') },
    { stage: 'empty', count: count('empty') },
    { stage: 'deduped', count: count('deduped') },
    { stage: 'budget', count: stages.truncated === true ? Math.max(0, collected - emitted - known) : 0 },
  ].filter((item) => item.count > 0);
  const dropped = Math.max(0, collected - emitted);
  const capture = buildCaptureReport(captureStagesFromPageStages(stages));
  return {
    collected,
    emitted,
    dropped,
    droppedReasons: reasons,
    keptRate: collected > 0 ? Math.round((emitted / collected) * 1000) / 1000 : 0,
    tokens: count('tokens'),
    truncated: stages.truncated === true,
    // 显式六阶段：阶段内 input/output/dropped/dropReasons/ms 一律可解释。
    stages: capture.stages,
    capture: {
      version: capture.version,
      stageNames: capture.stageNames,
      totals: capture.totals,
      complete: capture.complete,
      consistent: capture.consistent,
      text: summarizeCaptureReport(capture),
    },
  };
}
