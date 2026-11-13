// ui/tab-picker.js —— 子页面共用的「目标标签页」选择器
export async function listTargetTabs() {
  const selfPrefix = chrome.runtime.getURL('');
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id != null)
    .filter((tab) => {
      const url = String(tab.url || '');
      if (!url) return false;
      if (url.startsWith(selfPrefix)) return false;
      return !/^(chrome|edge|about|devtools|view-source):/i.test(url);
    })
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

export async function fillTabSelect(select, preferredTabId) {
  const tabs = await listTargetTabs();
  select.textContent = '';
  if (!tabs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '没有可用的标签页（先打开一个网页）';
    select.appendChild(option);
    return tabs;
  }
  let matched = false;
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = (tab.title || tab.url || '标签页').slice(0, 70);
    if (Number(preferredTabId) === tab.id) {
      option.selected = true;
      matched = true;
    }
    select.appendChild(option);
  }
  if (!matched) select.value = String(tabs[0].id);
  return tabs;
}

export function selectedTabId(select) {
  const value = select.value;
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

export function preferredTabFromQuery() {
  const params = new URLSearchParams(location.search);
  const value = params.get('tab');
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

export async function back() {
  const tab = await chrome.tabs.getCurrent();
  if (tab && tab.id != null) chrome.tabs.remove(tab.id);
  else window.close();
}
