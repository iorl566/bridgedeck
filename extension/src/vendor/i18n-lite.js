const MESSAGES = {
  'extension:popup.brandName': 'BridgeDeck',
  'extension:cooperation.label': '协作中',
  'extension:cooperation.resume': '继续',
  'extension:cooperation.hold': '暂停',
  'extension:cooperation.stop': '停止',
  'extension:cooperation.ready': '就绪',
  'extension:cooperation.human': '人工操作',
  'extension:cooperation.held': '已暂停',
  'extension:cooperation.yielding': '让出中',
  'extension:cooperation.syncing': '同步中',
  'extension:cooperation.acting': '执行中',
  'extension:cooperation.unavailable': '不可用',
  'extension:cooperation.editing': '编辑中',
  'extension:cooperation.hints.ready': '等待操作',
  'extension:cooperation.hints.human': '检测到人工输入',
  'extension:cooperation.hints.held': '控制已暂停',
  'extension:cooperation.hints.yielding': '正在让出控制',
  'extension:cooperation.hints.syncing': '正在同步页面',
  'extension:cooperation.hints.acting': '正在执行',
  'extension:cooperation.hints.unavailable': '当前不可用',
  'extension:controlOverlay.resumeController': '继续 {name}',
  'extension:controlOverlay.holdController': '暂停 {name}',
  'extension:controlOverlay.project': '项目',
  'extension:controlOverlay.session': '会话',
  'extension:controlOverlay.status': '控制中',
  'extension:controlOverlay.expand': '展开',
  'extension:controlOverlay.minimize': '最小化',
  'extension:controlOverlay.interrupting': '正在中断',
  'extension:recordOverlay.recording': '正在录制',
  'extension:recordOverlay.finish': '结束录制',
  'extension:borrowConfirmation.title': '浏览器借用请求',
  'extension:borrowConfirmation.titleInactive': '另一个标签页请求借用',
  'extension:borrowConfirmation.body': '一个 Agent 请求临时接管当前标签页以完成任务。',
  'extension:borrowConfirmation.targetTab': '目标标签页：',
  'extension:borrowConfirmation.autoDeny': '{count} 秒后自动拒绝',
  'extension:borrowConfirmation.allow': '允许',
  'extension:borrowConfirmation.deny': '拒绝',
  'extension:helpRequest.title': '需要你的帮助',
  'extension:helpRequest.compactStatus': '另一个标签页需要帮助',
  'extension:helpRequest.continue': '继续',
  'extension:helpRequest.cancel': '取消',
  'extension:helpRequest.dragHandle': '拖动',
  'extension:helpRequest.expand': '展开',
  'extension:helpRequest.collapse': '收起',
  'extension:helpRequest.noteLabel': '给 Agent 的说明',
  'extension:helpRequest.notePlaceholder': '可选：说明你做了什么',
};

export function translate(key, params = {}, namespace = 'extension') {
  const template = MESSAGES[`${namespace}:${key}`] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

export function useTranslation(namespace = 'extension') {
  return { t: (key, params) => translate(key, params, namespace) };
}
