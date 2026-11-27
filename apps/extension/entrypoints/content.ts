import { installContentBridge } from '@/src/content/entry';
import { installHumanWatch } from '@/src/content/cooperation';

/**
 * 内容脚本（M-C 第二批）：页面侧动作桥。
 *
 * 接收 background 下发的 `{type:'bb.content'}` 消息，在页面里执行：
 * - observe：语义树 + `@eN` ref（可见性用 computed style 判定）；
 * - click：ref/selector 解析 + elementFromPoint 命中校验 + 合成 click；
 * - fill：原生 value setter + input/change + 读回校验；
 * - read/select/get-html/evaluate：只读与薄动作。
 *
 * 不使用 chrome.debugger（避免与根 extension 竞争 attach），因此输入是合成事件
 * （isTrusted=false），证据里如实标注。与 0.3.0 页面注入库（page-lib.js）不同，
 * 这一层是 TS 实现、只覆盖 M-C 需要的最小动作面。
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  matchAboutBlank: true,
  main() {
    installContentBridge();
    // 人工输入监听（23u/23x）：isTrusted 输入 + 静默窗口，回传 bb.human.activity / bb.human.blur。
    installHumanWatch();
  },
});
