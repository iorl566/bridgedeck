const MAX_CONSOLE_FIELD_LENGTH = 4096;
const MAX_CONSOLE_STACK_FRAMES = 20;

function remoteObjectToText(value) {
  const raw = value ?? {};
  if ('value' in raw && raw.value !== undefined) return String(raw.value);
  if (typeof raw.description === 'string') return raw.description;
  if (typeof raw.unserializableValue === 'string') return raw.unserializableValue;
  if (typeof raw.type === 'string') return `[${raw.type}]`;
  return '';
}

function parseStackTrace(value) {
  const raw = value ?? {};
  const frames = Array.isArray(raw.callFrames) ? raw.callFrames : [];
  return frames.filter((frame) => frame !== null && typeof frame === 'object').map((frame) => ({
    function_name: typeof frame.functionName === 'string' && frame.functionName.length > 0 ? frame.functionName : undefined,
    url: typeof frame.url === 'string' && frame.url.length > 0 ? frame.url : undefined,
    line: typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : undefined,
    column: typeof frame.columnNumber === 'number' ? frame.columnNumber + 1 : undefined,
  }));
}

function firstLine(value) {
  if (!value) return undefined;
  return value.split(/\r?\n/, 1)[0] || undefined;
}

function truncateText(value, maxChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function truncateOptionalConsoleField(value) {
  return value === undefined ? undefined : truncateText(value, MAX_CONSOLE_FIELD_LENGTH).text;
}

function makeConsoleEntry(input) {
  const projected = truncateText(input.text, MAX_CONSOLE_FIELD_LENGTH);
  return {
    kind: input.kind,
    level: input.level,
    text: projected.text,
    url: truncateOptionalConsoleField(input.url),
    line: input.line,
    column: input.column,
    timestamp: input.timestamp,
    stack_trace: input.stack_trace.slice(0, MAX_CONSOLE_STACK_FRAMES).map((frame) => ({
      function_name: truncateOptionalConsoleField(frame.function_name),
      url: truncateOptionalConsoleField(frame.url),
      line: frame.line,
      column: frame.column,
    })),
    truncated: projected.truncated || input.stack_trace.length > MAX_CONSOLE_STACK_FRAMES,
  };
}

export function parseConsoleApiCalled(params) {
  const raw = params ?? {};
  const args = Array.isArray(raw.args) ? raw.args : [];
  const text = args.map(remoteObjectToText).filter(Boolean).join(' ');
  const stackTrace = parseStackTrace(raw.stackTrace);
  const top = stackTrace[0];
  return makeConsoleEntry({
    kind: 'console',
    level: typeof raw.type === 'string' ? raw.type : 'log',
    text,
    url: top?.url,
    line: top?.line,
    column: top?.column,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    stack_trace: stackTrace,
  });
}

export function parseExceptionThrown(params) {
  const raw = params ?? {};
  const details = raw.exceptionDetails ?? {};
  const exception = details.exception ?? {};
  const text = firstLine(remoteObjectToText(exception)) || firstLine(typeof details.text === 'string' ? details.text : undefined) || 'Uncaught (unknown error)';
  return makeConsoleEntry({
    kind: 'exception',
    level: 'error',
    text,
    url: typeof details.url === 'string' ? details.url : undefined,
    line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : undefined,
    column: typeof details.columnNumber === 'number' ? details.columnNumber + 1 : undefined,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    stack_trace: parseStackTrace(details.stackTrace),
  });
}

export function parseLogEntry(params) {
  const raw = params ?? {};
  const entry = raw.entry ?? {};
  return makeConsoleEntry({
    kind: 'log',
    level: typeof entry.level === 'string' ? entry.level : 'info',
    text: typeof entry.text === 'string' ? entry.text : '',
    url: typeof entry.url === 'string' ? entry.url : undefined,
    line: typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined,
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : undefined,
    stack_trace: [],
  });
}
