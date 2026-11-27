// tests/eval/dom/eval-dom-cases.js —— deterministic DOM 夹具：把可验证事实写进 #eval-facts。
//
// 设计约束：
// - 只用内联 DOM/CSS，无网络、无随机、无计时器、无动画（transition: none）；
// - 所有事实都是浏览器真实计算结果（elementFromPoint / getComputedStyle / getBoundingClientRect）；
// - 事实只记录观测值，断言在 Node 侧由 tests/eval/cases/dom-cases.json 决定（oracle 与夹具分离，
//   负向 case 才能真的失败）；
// - 失败时把错误写进 facts.__error 并把 title 置为 EVAL_DOM_FAIL，由 runner 报基础设施错误。

function round(value) {
  return Math.round(Number(value) || 0);
}

function idOf(element) {
  if (!element) return null;
  return element.id || element.tagName.toLowerCase();
}

function computeFacts() {
  const facts = {};
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  facts['page.viewportWidth'] = viewport.width;
  facts['page.viewportHeight'] = viewport.height;

  // 1) fixed 浮层命中：fixed-overlay 覆盖 under-button 的左上角。
  facts['hit.overlayTopId'] = idOf(document.elementFromPoint(20, 20));

  // 2) pointer-events:none 浮层点击穿透到下层。
  facts['hit.throughTargetId'] = idOf(document.elementFromPoint(30, 65));

  // 3) 同层 z-index：高 z-index 的 stack-high 命中，stack-low 在下。
  facts['stack.lowId'] = 'stack-low';
  facts['stack.highId'] = 'stack-high';
  facts['hit.stackTopId'] = idOf(document.elementFromPoint(10, 170));

  // 4) closed shadow DOM：shadowRoot 不可见、内部节点不被 elementsFromPoint 暴露、事件重定向到 host。
  const host = document.getElementById('closed-host');
  let hostClicks = 0;
  host.addEventListener('click', () => { hostClicks += 1; });
  const shadow = host.attachShadow({ mode: 'closed' });
  const inner = document.createElement('button');
  inner.id = 'shadow-inner';
  inner.type = 'button';
  inner.style.cssText = 'position:absolute;left:0;top:0;width:40px;height:20px;';
  shadow.appendChild(inner);
  const hostRect = host.getBoundingClientRect();
  const hitHost = document.elementFromPoint(round(hostRect.left + 10), round(hostRect.top + 10));
  facts['shadow.closed'] = host.shadowRoot === null;
  facts['shadow.hitId'] = idOf(hitHost);
  facts['shadow.innerExposed'] = document.elementsFromPoint(round(hostRect.left + 10), round(hostRect.top + 10))
    .some((element) => element && element.id === 'shadow-inner');
  host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  facts['shadow.hostClickCount'] = hostClicks;

  // 5) RTL：逻辑方向与 margin-inline-start 的物理映射，以及右侧留白（padding + margin）。
  const rtlBox = document.getElementById('rtl-box');
  const rtlChild = document.getElementById('rtl-child');
  const rtlStyle = getComputedStyle(rtlBox);
  const childStyle = getComputedStyle(rtlChild);
  facts['rtl.direction'] = rtlStyle.direction;
  facts['rtl.marginLeft'] = childStyle.marginLeft;
  facts['rtl.marginRight'] = childStyle.marginRight;
  facts['rtl.rightGap'] = round(rtlBox.getBoundingClientRect().right - rtlChild.getBoundingClientRect().right);

  // 6) toast 生命周期：class 驱动 opacity（transition: none，读数确定）。
  const toast = document.getElementById('toast');
  facts['toast.text'] = toast.textContent;
  facts['toast.hideOpacity'] = getComputedStyle(toast).opacity;
  toast.classList.add('show');
  facts['toast.showOpacity'] = getComputedStyle(toast).opacity;

  // 7) 原生 dialog top-layer：背景被模态层挡住，焦点留在对话框内。
  const modal = document.getElementById('modal');
  const backgroundButton = document.getElementById('under-button');
  modal.showModal();
  facts['modal.open'] = modal.open;
  facts['modal.isModal'] = modal.matches(':modal');
  facts['modal.backgroundHitId'] = idOf(document.elementFromPoint(20, 20));
  const modalInput = document.getElementById('modal-input');
  modalInput.focus();
  facts['modal.activeId'] = idOf(document.activeElement);
  backgroundButton.focus();
  facts['modal.activeAfterBackgroundFocus'] = idOf(document.activeElement);
  facts['modal.focusContained'] = modal.contains(document.activeElement);
  facts['modal.contentHitId'] = idOf(document.elementFromPoint(
    round(window.innerWidth / 2),
    round(window.innerHeight / 2),
  ));

  // 8) sticky 顶栏：滚动后贴住视口顶部。
  window.scrollTo(0, 200);
  const sticky = document.getElementById('sticky-header');
  facts['page.scrollY'] = round(window.scrollY);
  facts['sticky.topAfterScroll'] = round(sticky.getBoundingClientRect().top);

  return facts;
}

try {
  const facts = computeFacts();
  const holder = document.getElementById('eval-facts');
  holder.textContent = JSON.stringify(facts);
  document.title = 'EVAL_DOM_OK:' + Object.keys(facts).length;
} catch (error) {
  const holder = document.getElementById('eval-facts');
  const payload = { __error: String((error && error.message) || error), __stack: String((error && error.stack) || '') };
  holder.textContent = JSON.stringify(payload);
  document.title = 'EVAL_DOM_FAIL:' + payload.__error;
}
