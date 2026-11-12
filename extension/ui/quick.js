// ui/quick.js —— 快捷功能入口页
const PAGES = {
  record: 'record.html',
  debug: 'debug.html',
  longshot: 'longshot.html',
  ops: 'ops.html',
  audit: 'audit.html',
};

document.getElementById('back').addEventListener('click', async () => {
  const params = new URLSearchParams(location.search);
  if (params.get('from') === 'popup') {
    location.href = 'popup.html';
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  if (tab && tab.id != null) chrome.tabs.remove(tab.id);
  else window.close();
});

for (const button of document.querySelectorAll('.entry')) {
  button.addEventListener('click', () => {
    const page = button.getAttribute('data-page');
    const file = PAGES[page];
    if (!file) return;
    const tab = new URLSearchParams(location.search).get('tab');
    const url = chrome.runtime.getURL('ui/' + file) + (tab && /^\d+$/.test(tab) ? '?tab=' + tab : '');
    chrome.tabs.create({ url });
  });
}
