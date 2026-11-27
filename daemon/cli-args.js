// daemon/cli-args.js —— daemon 命令行参数解析。

export function parseServerArgs(argv) {
  const opts = { port: null, foreground: false, stop: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        console.error('--port 需要一个 1-65535 的整数');
        process.exit(2);
      }
      opts.port = value;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        console.error('--port 需要一个 1-65535 的整数');
        process.exit(2);
      }
      opts.port = value;
    } else if (arg === '--foreground') {
      opts.foreground = true;
    } else if (arg === '--stop') {
      opts.stop = true;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}


export function createUsagePrinter({ VERSION, HOME_DIR, LOG_PATH }) {
  return function printUsage() {

    console.log(`BridgeDeck daemon v${VERSION}
  
  用法：
    node daemon/server.mjs [--port <n>] [--foreground]
    node daemon/server.mjs --stop
    node daemon/server.mjs --help
  
  说明：
    默认后台 detached 拉起自身并退出；--foreground 前台运行（CLI 自动拉起用此模式）。
    --port     指定监听端口（默认 BB_PORT，否则 52900..52909 取第一个可用）
    --stop     优雅停止正在运行的 daemon 并清理 daemon.json
    状态目录    ${HOME_DIR}（BB_HOME 可覆盖）
    日志        ${LOG_PATH}（5MB 轮转）`);
  
  };
}
