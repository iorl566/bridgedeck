// cli/commands/daemon-log.mjs —— daemon log/tail/follow（从 bridge 拆出）。
import fs from 'node:fs';

export function createDaemonLogCommands(ctx) {
  const { LOG_PATH, formatBytes, emitJson, isJson, print } = ctx;

function cmdDaemonLog(flags) {
    const exists = fs.existsSync(LOG_PATH);
    const size = exists ? fs.statSync(LOG_PATH).size : 0;
    const tailWanted = flags.tail !== undefined ? (typeof flags.tail === 'number' ? flags.tail : 50) : 0;
    if (flags.follow === true) return followLog(tailWanted);
    let lines = [];
    if (exists && tailWanted > 0) lines = tailFile(LOG_PATH, tailWanted);
    if (isJson()) {
      emitJson({ ok: true, result: { path: LOG_PATH, exists, size, lines } });
      return 0;
    }
    if (!exists) {
      print(`日志文件不存在：${LOG_PATH}`);
      return 0;
    }
    if (tailWanted > 0) print(lines.join('\n'));
    else print(`日志文件：${LOG_PATH}（${formatBytes(size)}）`);
    return 0;
  }
  
  /** 持续跟踪 daemon 日志：先按 --tail 打一段，再等新增字节；Ctrl+C 结束。 */
  async function followLog(tailWanted) {
    if (!fs.existsSync(LOG_PATH)) {
      print('日志文件不存在：' + LOG_PATH);
      return 0;
    }
    if (tailWanted > 0) process.stdout.write(tailFile(LOG_PATH, tailWanted).join('\n') + '\n');
    let offset = fs.statSync(LOG_PATH).size;
    process.stderr.write('（持续跟踪 ' + LOG_PATH + '，Ctrl+C 结束）\n');
    return await new Promise((resolve) => {
      const timer = setInterval(() => {
        try {
          const size = fs.statSync(LOG_PATH).size;
          if (size < offset) offset = 0; // 日志轮转
          if (size === offset) return;
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          const fd = fs.openSync(LOG_PATH, 'r');
          try { fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
          offset = size;
          process.stdout.write(buffer.toString('utf8'));
        } catch { /* 文件被删除/轮转中，下一轮再试 */ }
      }, 400);
      process.once('SIGINT', () => {
        clearInterval(timer);
        resolve(0);
      });
    });
  }
  
  function tailFile(file, count) {
    try {
      const stat = fs.statSync(file);
      const maxBytes = 256 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
      let text = buffer.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return text.split(/\r?\n/).filter(Boolean).slice(-count);
    } catch {
      return [];
    }
  }
  return { cmdDaemonLog };
}
