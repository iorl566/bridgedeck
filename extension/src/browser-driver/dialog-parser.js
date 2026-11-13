const MAX_DIALOG_FIELD_LENGTH = 4096;

export function normalizeDialogType(value) {
  return ['alert', 'confirm', 'prompt', 'beforeunload'].includes(value) ? value : 'alert';
}

export function truncateDialogField(value) {
  if (value.length <= MAX_DIALOG_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_DIALOG_FIELD_LENGTH)}... [truncated]`;
}

export function parseDialogOpeningParams(params) {
  const raw = params ?? {};
  return {
    type: normalizeDialogType(raw.type),
    message: truncateDialogField(typeof raw.message === 'string' ? raw.message : ''),
    url: typeof raw.url === 'string' ? truncateDialogField(raw.url) : undefined,
    defaultPrompt: typeof raw.defaultPrompt === 'string' ? raw.defaultPrompt : undefined,
    hasBrowserHandler: typeof raw.hasBrowserHandler === 'boolean' ? raw.hasBrowserHandler : undefined,
  };
}
