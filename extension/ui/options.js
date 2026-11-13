// ui/options.js —— 设置页
import { DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings } from '../src/settings.js';
import { getLang, setLang, whenReady } from './i18n.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['instanceLabel', 'borrowConfirm', 'allowHelp', 'longShotMode', 'pageGuard'];

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.className = 'toast show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 1600);
}

function render(settings) {
  $('instanceLabel').value = settings.instanceLabel || '';
  $('borrowConfirm').checked = settings.borrowConfirm === true;
  $('allowHelp').checked = settings.allowHelp === true;
  $('pageGuard').checked = settings.pageGuard === true;
  $('longShotMode').value = settings.longShotMode === 'manual' ? 'manual' : 'auto';
  renderCommand(settings.instanceLabel);
}

function renderCommand(label) {
  const selector = label ? ' --browser "' + label + '"' : '';
  $('cmdPreview').textContent = 'bridge session start' + selector;
}

function collect() {
  return normalizeSettings({
    instanceLabel: $('instanceLabel').value,
    borrowConfirm: $('borrowConfirm').checked,
    allowHelp: $('allowHelp').checked,
    pageGuard: $('pageGuard').checked,
    longShotMode: $('longShotMode').value,
  });
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await writeSettings(collect());
  render(settings);
  toast('已保存');
});

$('reset').addEventListener('click', async () => {
  const settings = await writeSettings({ ...DEFAULT_SETTINGS });
  render(settings);
  toast('已恢复默认');
});

$('instanceLabel').addEventListener('input', () => {
  renderCommand($('instanceLabel').value.trim());
});

whenReady().then(() => {
  const select = $('uiLang');
  if (select) select.value = getLang();
});

$('uiLang')?.addEventListener('change', (event) => {
  void setLang(event.target.value);
});

$('copyCmd').addEventListener('click', async () => {
  const label = $('instanceLabel').value.trim();
  const selector = label ? ' --browser "' + label + '"' : '';
  const command = 'bridge session start' + selector + ' --json';
  try {
    await navigator.clipboard.writeText(command);
    toast('已复制：' + command);
  } catch {
    toast('复制失败，请手动复制：' + command);
  }
});

readSettings().then(render);
