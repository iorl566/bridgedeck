// lib/tools.mjs —— 模型可见工具的纯定义（不依赖 DSH 运行时，便于单测）
const SESSION = {
  type: 'string',
  description: 'BridgeDeck会话 id（bridge session start 返回）。只有一个会话时可省略。',
};

function withSession(argv, args) {
  const out = argv.slice();
  if (args && typeof args.sessionId === 'string' && args.sessionId) out.push('--session', args.sessionId);
  return out;
}

function requireTarget(args) {
  if (args && typeof args.ref === 'string' && args.ref) return args.ref;
  if (args && typeof args.selector === 'string' && args.selector) return args.selector;
  throw new Error('需要 ref（@eN）或 selector（CSS）之一');
}

function filterObservation(text, grep) {
  if (!grep) return text;
  const needle = String(grep).toLowerCase();
  return String(text || '').split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).join('\n');
}

/**
 * 生成工具规格数组。
 * @param {(argv: string[], exec: any) => Promise<any>} run 调用 bridge CLI 的函数
 */
export function buildToolSpecs(run) {
  const call = (argv, args, exec) => run(withSession(argv, args), exec);

  return [
    {
      name: 'browser_status',
      description: '查看BridgeDeck 的状态：daemon 是否在跑、已连接的浏览器实例（含实例名）、活动会话。任务开始时先用它确认环境。',
      parameters: {},
      async execute(args, exec) {
        const status = await run(['status'], exec);
        return {
          port: status.port,
          version: status.version,
          browsers: status.browsers || [],
          sessions: status.sessions || [],
        };
      },
    },
    {
      name: 'browser_session_start',
      description: '建立一个浏览器会话：默认在后台开一个独立 Agent 窗口。要给用户的标签页干活，先用 tabId 借用；要指定浏览器，用 browser（实例 id 或实例名）。返回 sessionId。',
      parameters: {
        browser: { type: 'string', description: '浏览器实例 id 或设置页里起的名字；只有一台时可省略。' },
        tab: { type: 'integer', description: '要借用的已有标签页 tabId（用户窗口里的）。' },
        noFocus: { type: 'boolean', description: '为 true 时不把 Agent 窗口抢到前台（默认会抢）。' },
      },
      async execute(args, exec) {
        const argv = ['session', 'start'];
        if (args && typeof args.browser === 'string' && args.browser) argv.push('--browser', args.browser);
        if (args && Number.isInteger(args.tab)) argv.push('--tab', String(args.tab));
        if (args && args.noFocus === true) argv.push('--no-focus');
        const result = await run(argv, exec);
        return {
          sessionId: result.sessionId,
          tabId: result.tabId,
          windowId: result.windowId,
          instanceId: result.instanceId,
          borrowed: result.borrowed === true,
        };
      },
    },
    {
      name: 'browser_session_stop',
      description: '结束会话。借用的用户标签页会被归还（保持打开），Agent 窗口的标签页会被关闭。任务结束前一定要调用。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '要结束的会话 id。' },
        keep: { type: 'boolean', description: '为 true 时只删会话记录、不关 Agent 标签页。' },
      },
      async execute(args, exec) {
        const argv = ['session', 'stop', args.sessionId];
        if (args && args.keep === true) argv.push('--keep');
        return run(argv, exec);
      },
    },
    {
      name: 'browser_navigate',
      description: '让会话所在标签页导航到指定 URL，等加载完成并返回最终 url/title。导航后旧的 @eN ref 会失效，需要重新 observe。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的 http(s) URL。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        return call(['navigate', args.url], args, exec);
      },
    },
    {
      name: 'browser_observe',
      description: '读取当前页面的语义树：可交互节点带 @eN ref（例如 link "登录" [@e3]）。点、填、选都用这些 ref。可用 grep 只看包含某段文字的行。',
      parameters: {
        probeHover: { type: 'boolean', description: '为 true 时额外探测悬停才展开的菜单项。' },
        vom: { type: 'boolean', description: '为 true 时额外返回结构化节点数组（role/name/rect/inputState/inForm/clickable/dragHint 等），便于按字段决策。' },
        grep: { type: 'string', description: '只看包含该子串的行（不区分大小写）。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const argv = ['observe'];
        if (args && args.probeHover === true) argv.push('--probe-hover');
        if (args && args.vom === true) argv.push('--vom');
        const result = await call(argv, args, exec);
        return {
          url: result.url,
          title: result.title,
          refs: result.refs,
          observation: filterObservation(result.observation, args && args.grep),
          ...(args && args.vom === true ? { nodes: result.nodes || [], blocking: result.blocking || null } : {}),
        };
      },
    },
    {
      name: 'browser_act',
      description: '对页面执行一个动作。action=click/hover/focus/blur/scrollTo 用 ref 或 selector；fill/select 另给 value；press 给 key；drag 给 ref/selector 与 to；wheel 给 deltaY。动作前应先 observe 拿 ref。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'click | hover | focus | blur | scrollTo | fill | select | press | drag | wheel',
        },
        ref: { type: 'string', description: 'observe 给出的 @eN。' },
        selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）。' },
        value: { type: 'string', description: 'fill 的文本，或 select 的 option value。' },
        key: { type: 'string', description: 'press 的按键，如 Enter、Escape、Ctrl+A。' },
        to: { type: 'string', description: 'drag 的目标 ref/selector。' },
        mode: { type: 'string', description: 'drag 模式：hold（默认）或 click-move-click。' },
        deltaY: { type: 'number', description: 'wheel 的纵向滚动量（正数向下）。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        const target = action === 'wheel' ? null : requireTarget(args);
        const argv = [];
        if (action === 'click' || action === 'hover' || action === 'focus' || action === 'blur' || action === 'scrollTo') {
          argv.push(action === 'scrollTo' ? 'scroll-to' : action);
          if (target) argv.push(target);
        } else if (action === 'fill' || action === 'select') {
          if (typeof args.value !== 'string') throw new Error(action + ' 需要 value');
          argv.push(action, target, '--value', args.value);
        } else if (action === 'press') {
          if (typeof args.key !== 'string' || !args.key) throw new Error('press 需要 key');
          argv.push('press', args.key);
          if (target) argv.push(target);
        } else if (action === 'drag') {
          if (typeof args.to !== 'string' || !args.to) throw new Error('drag 需要 to');
          argv.push('drag', target, '--to', args.to);
          if (typeof args.mode === 'string' && args.mode) argv.push('--mode', args.mode);
        } else if (action === 'wheel') {
          if (typeof args.deltaY !== 'number') throw new Error('wheel 需要 deltaY');
          argv.push('wheel', '--delta-y', String(Math.round(args.deltaY)));
          if (target) argv.push(target);
        } else {
          throw new Error('不支持的 action：' + action);
        }
        return call(argv, args, exec);
      },
    },
    {
      name: 'browser_read',
      description: '读取页面数据。kind=read 读表单字段值（给 ref/selector 或 all=true），kind=html 取 HTML，kind=extract 把表格/列表导出成 {columns, rows}。',
      parameters: {
        kind: { type: 'string', required: true, description: 'read | html | extract' },
        ref: { type: 'string', description: '@eN（与 selector 二选一）。' },
        selector: { type: 'string', description: 'CSS 选择器。' },
        all: { type: 'boolean', description: 'read 时读整页所有表单控件。' },
        maxRows: { type: 'integer', description: 'extract 的最大行数（默认 500）。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const kind = String(args.kind || '');
        const target = args.ref || args.selector ? requireTarget(args) : null;
        if (kind === 'read') {
          const argv = ['read'];
          if (args.all === true) argv.push('--all');
          else if (target) argv.push(target);
          const result = await call(argv, args, exec);
          return { fields: result.fields || [] };
        }
        if (kind === 'html') {
          const argv = ['get-html'];
          if (target) argv.push(target);
          const result = await call(argv, args, exec);
          return { html: result.html, url: result.url };
        }
        if (kind === 'extract') {
          const argv = ['extract'];
          if (target) argv.push(target);
          if (Number.isInteger(args.maxRows)) argv.push('--max-rows', String(args.maxRows));
          const result = await call(argv, args, exec);
          return {
            kind: result.kind,
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
          };
        }
        throw new Error('kind 只能是 read | html | extract');
      },
    },
    {
      name: 'browser_screenshot',
      description: '截图并落盘，返回文件路径与尺寸。mode=visible（默认）|auto（整页滚动拼接）。',
      parameters: {
        out: { type: 'string', required: true, description: '保存路径（.png）。' },
        mode: { type: 'string', description: 'visible | auto' },
        selector: { type: 'string', description: '元素选择器，截取该元素。' },
        region: { type: 'string', description: '像素区域 x,y,w,h。' },
        annotate: { type: 'boolean', description: '是否绘制 @eN 标注。' },
        overlap: { type: 'integer', description: '整页分片重叠像素数。' },
        fullPage: { type: 'boolean', description: '是否整页滚动拼接。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const argv = ['screenshot', '--out', args.out];
        if (typeof args.mode === 'string' && args.mode) argv.push('--mode', args.mode);
        if (args.fullPage === true) argv.push('--full');
        if (typeof args.selector === 'string' && args.selector) argv.push('--selector', args.selector);
        if (typeof args.region === 'string' && args.region) argv.push('--region', args.region);
        if (args.annotate === true) argv.push('--annotate');
        if (Number.isInteger(args.overlap) && args.overlap >= 0) argv.push('--overlap', String(args.overlap));
        const result = await call(argv, args, exec);
        return { path: result.path, width: result.width, height: result.height, bytes: result.bytes };
      },
    },
    {
      name: 'browser_eval',
      description: '在页面主世界执行一段 JS 表达式并返回结果（只做用户要求的页面操作，别用它读 cookie/密码）。',
      parameters: {
        expression: { type: 'string', required: true, description: '要执行的表达式。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const result = await call(['evaluate', args.expression], args, exec);
        return { value: result.value, note: result.note || null };
      },
    },
    {
      name: 'browser_network',
      description: '抓当前会话的网络请求：action=start 开始采集（bodies=true 才取响应正文），list 列出（可按子串过滤），detail 看单条，stop 结束。',
      parameters: {
        action: { type: 'string', required: true, description: 'start | list | detail | stop' },
        bodies: { type: 'boolean', description: 'start 时是否采集正文（会挂调试器）。' },
        id: { type: 'integer', description: 'detail 的记录 id。' },
        filter: { type: 'string', description: 'list 的 URL 子串过滤。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'start') {
          const argv = ['network', 'start'];
          if (args.bodies === true) argv.push('--bodies');
          return call(argv, args, exec);
        }
        if (action === 'stop') return call(['network', 'stop'], args, exec);
        if (action === 'list') {
          const argv = ['network', 'list'];
          if (typeof args.filter === 'string' && args.filter) argv.push('--filter', args.filter);
          const result = await call(argv, args, exec);
          return { entries: result.entries || [], active: result.active === true };
        }
        if (action === 'detail') {
          if (!Number.isInteger(args.id)) throw new Error('detail 需要 id');
          return call(['network', 'detail', String(args.id)], args, exec);
        }
        throw new Error('action 只能是 start | list | detail | stop');
      },
    },
    {
      name: 'browser_dialog',
      description: '处理页面原生弹窗（alert/confirm/prompt）。action=arm 先挂上并给定策略，之后弹窗自动处理；list 回看；disarm 卸载。挂载期间浏览器会显示调试提示条。',
      parameters: {
        action: { type: 'string', required: true, description: 'arm | list | disarm' },
        confirm: { type: 'string', description: 'confirm 的策略：accept | dismiss（默认 dismiss）。' },
        alert: { type: 'string', description: 'alert 的策略：accept | dismiss（默认 dismiss）。' },
        prompt: { type: 'string', description: 'prompt 的策略：accept | dismiss（默认 dismiss）。' },
        promptText: { type: 'string', description: 'prompt 被接受时填入的文本。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'arm') {
          const argv = ['dialog', 'arm'];
          for (const key of ['alert', 'confirm', 'prompt']) {
            if (typeof args[key] === 'string' && args[key]) argv.push('--' + key, args[key]);
          }
          if (typeof args.promptText === 'string') argv.push('--prompt-text', args.promptText);
          return call(argv, args, exec);
        }
        if (action === 'list') {
          const result = await call(['dialog', 'list'], args, exec);
          return { dialogs: result.dialogs || [], armed: result.armed === true };
        }
        if (action === 'disarm') return call(['dialog', 'disarm'], args, exec);
        throw new Error('action 只能是 arm | list | disarm');
      },
    },
    {
      name: 'browser_tab_borrow',
      description: '借用用户已有的标签页。接管前会按扩展设置弹确认条；用完 session stop 会自动归还，标签页保持打开。',
      parameters: {
        tabId: { type: 'integer', required: true, description: '要借用的标签页 id。' },
      },
      async execute(args, exec) {
        return run(['tab', 'borrow', String(args.tabId)], exec);
      },
    },
    {
      name: 'browser_debug',
      description: '网站调试：采集请求/控制台/页面上下文/性能，导出、分析或归档。action=start|stop|requests|request|console|performance|export|analyze|journal|archive|archives。',
      parameters: {
        action: { type: 'string', required: true, description: 'start | stop | requests | request | console | performance | export | analyze | journal | evidence | query | archive | archives | rule_list | rule_enable | rule_disable | rule_remove' },
        name: { type: 'string', description: 'start 时的采集名。' },
        bodies: { type: 'boolean', description: 'start 时是否采集请求/响应正文。' },
        filter: { type: 'string', description: 'requests 时按 URL 子串过滤。' },
        ruleId: { type: 'integer', description: 'rule_enable/disable/remove 的规则 id。' },
        id: { type: 'integer', description: 'request 的请求 id。' },
        part: { type: 'string', description: 'request 的片段：headers | timing | request | response | all。' },
        out: { type: 'string', description: 'export/archive 的输出文件。' },
        file: { type: 'string', description: 'analyze 的离线归档文件。' },
        dir: { type: 'string', description: 'archives 的归档目录。' },
        prune: { type: 'boolean', description: 'archives 时清理过期条目。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'analyze') {
          const argv = ['debug', 'analyze'];
          if (typeof args.file === 'string' && args.file) argv.push('--file', args.file);
          return call(argv, args, exec);
        }
        if (action === 'journal') return call(['debug', 'journal'], args, exec);
        if (action === 'rule_list') return call(['debug', 'rule_list'], args, exec);
        if (action === 'rule_enable' || action === 'rule_disable' || action === 'rule_remove') {
          if (!Number.isInteger(args.ruleId)) throw new Error(action + ' 需要 ruleId');
          return call(['debug', action, String(args.ruleId)], args, exec);
        }
        if (action === 'evidence') {
          if (typeof args.out !== 'string' || !args.out) throw new Error('evidence 需要 out');
          const argv = ['debug', 'evidence', '--output', args.out];
          if (typeof args.file === 'string' && args.file) argv.push('--file', args.file);
          return call(argv, args, exec);
        }
        if (action === 'query') {
          if (typeof args.file !== 'string' || !args.file) throw new Error('query 需要 file');
          const argv = ['debug', 'query', '--file', args.file];
          if (typeof args.filter === 'string' && args.filter) argv.push('--filter', args.filter);
          return call(argv, args, exec);
        }
        if (action === 'archive') {
          if (typeof args.out !== 'string' || !args.out) throw new Error('archive 需要 out');
          return call(['debug', 'archive', '--output', args.out], args, exec);
        }
        if (action === 'archives') {
          if (typeof args.dir !== 'string' || !args.dir) throw new Error('archives 需要 dir');
          const argv = ['debug', 'archives', '--dir', args.dir];
          if (args.prune === true) argv.push('--prune');
          return call(argv, args, exec);
        }
        if (action === 'start') {
          const argv = ['debug', 'start'];
          if (typeof args.name === 'string' && args.name) argv.push('--name', args.name);
          if (args.bodies === true) argv.push('--bodies');
          return call(argv, args, exec);
        }
        if (action === 'stop') return call(['debug', 'stop'], args, exec);
        if (action === 'requests') {
          const argv = ['debug', 'requests'];
          if (typeof args.filter === 'string' && args.filter) argv.push('--filter', args.filter);
          return call(argv, args, exec);
        }
        if (action === 'request') {
          if (!Number.isInteger(args.id)) throw new Error('request 需要 id');
          const argv = ['debug', 'request', String(args.id)];
          if (typeof args.part === 'string' && args.part) argv.push('--part', args.part);
          return call(argv, args, exec);
        }
        if (action === 'console') return call(['debug', 'console'], args, exec);
        if (action === 'performance') return call(['debug', 'performance'], args, exec);
        if (action === 'export') {
          if (typeof args.out !== 'string' || !args.out) throw new Error('export 需要 out');
          return call(['debug', 'export', '--output', args.out], args, exec);
        }
        throw new Error('action 只能是 start|stop|requests|request|console|performance|export');
      },
    },
    {
      name: 'browser_video',
      description: '标签页视频录制：action=start|stop|save|list|prune|recover。start 返回 recordingId，stop/save 用它落盘。',
      parameters: {
        action: { type: 'string', required: true, description: 'start | stop | save | list | prune | recover' },
        duration: { type: 'string', description: 'start 的录制时长，如 30s / 2m。' },
        quality: { type: 'string', description: 'standard | high' },
        recording: { type: 'string', description: 'stop/save 的 recordingId。' },
        out: { type: 'string', description: 'save 的输出路径。' },
        overwrite: { type: 'boolean', description: 'save 时覆盖已有文件。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'recover') return call(['video', 'recover'], args, exec);
        if (action === 'start') {
          const argv = ['video', 'start'];
          if (typeof args.duration === 'string' && args.duration) argv.push('--duration', args.duration);
          if (typeof args.quality === 'string' && args.quality) argv.push('--quality', args.quality);
          return call(argv, args, exec);
        }
        if (action === 'stop' || action === 'save') {
          if (typeof args.recording !== 'string' || !args.recording) throw new Error(action + ' 需要 recording');
          const argv = ['video', action, args.recording];
          if (action === 'save') {
            if (typeof args.out !== 'string' || !args.out) throw new Error('save 需要 out');
            argv.push('--out', args.out);
            if (args.overwrite === true) argv.push('--overwrite');
          }
          return call(argv, args, exec);
        }
        if (action === 'list') return call(['video', 'list'], args, exec);
        if (action === 'prune') return call(['video', 'prune'], args, exec);
        throw new Error('action 只能是 start|stop|save|list|prune');
      },
    },
    {
      name: 'browser_record',
      description: '记录用户操作（语义动作）：action=start|stop|list|export。export 需要 out 目录。',
      parameters: {
        action: { type: 'string', required: true, description: 'start | stop | list | export' },
        out: { type: 'string', description: 'export 的输出目录。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (!['start', 'stop', 'list', 'export'].includes(action)) throw new Error('action 只能是 start|stop|list|export');
        if (action === 'export') {
          if (typeof args.out !== 'string' || !args.out) throw new Error('export 需要 out');
          return call(['record', 'export', '--out', args.out], args, exec);
        }
        return call(['record', action], args, exec);
      },
    },
    {
      name: 'browser_cooperate',
      description: '共享控制：action=sync（签发 context/observation）|wait（等人停手）|handback（人工交回）。',
      parameters: {
        action: { type: 'string', required: true, description: 'sync | wait | handback' },
        policy: { type: 'string', description: 'sync 的策略：auto | strict' },
        timeout: { type: 'string', description: 'wait 的超时，如 5s。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'sync') {
          const argv = ['cooperate', 'sync'];
          if (typeof args.policy === 'string' && args.policy) argv.push('--policy', args.policy);
          return call(argv, args, exec);
        }
        if (action === 'wait') {
          const argv = ['cooperate', 'wait'];
          if (typeof args.timeout === 'string' && args.timeout) argv.push('--timeout', args.timeout);
          return call(argv, args, exec);
        }
        if (action === 'handback') return call(['cooperate', 'handback'], args, exec);
        throw new Error('action 只能是 sync|wait|handback');
      },
    },
    {
      name: 'browser_recipe',
      description: '流程复用：action=list|show|save|approve|run|rm。save 生成草稿，approve 需要 confirmHuman=true。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | show | save | approve | run | rm' },
        name: { type: 'string', description: 'recipe 名称。' },
        file: { type: 'string', description: 'save 的 JSON 文件。' },
        params: { type: 'object', description: 'run 的参数键值对（会转成 --param k=v）。' },
        confirmHuman: { type: 'boolean', description: 'approve 时确认是人类操作。' },
        by: { type: 'string', description: 'approve 的审批人标记。' },
        sessionId: SESSION,
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'list') return call(['recipe', 'list'], args, exec);
        if (action === 'show' || action === 'rm') {
          if (typeof args.name !== 'string' || !args.name) throw new Error(action + ' 需要 name');
          return call(['recipe', action, args.name], args, exec);
        }
        if (action === 'save') {
          if (typeof args.name !== 'string' || !args.name) throw new Error('save 需要 name');
          if (typeof args.file !== 'string' || !args.file) throw new Error('save 需要 file');
          return call(['recipe', 'save', args.name, '--file', args.file], args, exec);
        }
        if (action === 'approve') {
          if (typeof args.name !== 'string' || !args.name) throw new Error('approve 需要 name');
          if (args.confirmHuman !== true) throw new Error('approve 需要 confirmHuman=true');
          const argv = ['recipe', 'approve', args.name, '--confirm-human'];
          if (typeof args.by === 'string' && args.by) argv.push('--by', args.by);
          return call(argv, args, exec);
        }
        if (action === 'run') {
          if (typeof args.name !== 'string' || !args.name) throw new Error('run 需要 name');
          const argv = ['recipe', 'run', args.name];
          if (args.params && typeof args.params === 'object') {
            for (const [key, value] of Object.entries(args.params)) argv.push('--param', key + '=' + String(value));
          }
          return call(argv, args, exec);
        }
        throw new Error('action 只能是 list|show|save|approve|run|rm');
      },
    },
    {
      name: 'browser_pair',
      description: '远程配对：action=create|list|redeem|revoke。create 返回配对码与 wss 地址。',
      parameters: {
        action: { type: 'string', required: true, description: 'create | list | redeem | revoke' },
        code: { type: 'string', description: 'redeem/revoke 的配对码。' },
        ttl: { type: 'string', description: 'create 的有效期，如 10m。' },
        label: { type: 'string', description: 'create 的标签。' },
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'create') {
          const argv = ['pair', 'create'];
          if (typeof args.ttl === 'string' && args.ttl) argv.push('--ttl', args.ttl);
          if (typeof args.label === 'string' && args.label) argv.push('--label', args.label);
          return run(argv, exec);
        }
        if (action === 'list') return run(['pair', 'list'], exec);
        if (action === 'redeem' || action === 'revoke') {
          if (typeof args.code !== 'string' || !args.code) throw new Error(action + ' 需要 code');
          return run(['pair', action, args.code], exec);
        }
        throw new Error('action 只能是 create|list|redeem|revoke');
      },
    },
    {
      name: 'browser_update',
      description: '更新状态：action=state|auto|check|fetch。auto 可开启/关闭后台检查。',
      parameters: {
        action: { type: 'string', required: true, description: 'state | auto | check | fetch' },
        enable: { type: 'boolean', description: 'auto 时开启/关闭。' },
        source: { type: 'string', description: 'auto/fetch 的 https 清单地址。' },
        out: { type: 'string', description: 'fetch 的输出文件。' },
        key: { type: 'string', description: '签名校验 key 文件。' },
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'state') return run(['update', 'state', '--json'], exec);
        if (action === 'auto') {
          const argv = ['update', 'auto'];
          if (args.enable === true) argv.push('--enable'); else if (args.enable === false) argv.push('--disable');
          if (typeof args.source === 'string' && args.source) argv.push('--source', args.source);
          if (typeof args.key === 'string' && args.key) argv.push('--key', args.key);
          argv.push('--json');
          return run(argv, exec);
        }
        if (action === 'fetch') {
          if (typeof args.source !== 'string' || !args.source) throw new Error('fetch 需要 source');
          const argv = ['update', 'fetch', '--source', args.source];
          if (typeof args.out === 'string' && args.out) argv.push('--out', args.out);
          if (typeof args.key === 'string' && args.key) argv.push('--key', args.key);
          argv.push('--json');
          return run(argv, exec);
        }
        if (action === 'check') return run(['update', 'check', '--json'], exec);
        throw new Error('action 只能是 state|auto|check|fetch');
      },
    },
    {
      name: 'browser_settings',
      description: '扩展设置：action=get|set。set 支持 label/borrowConfirm/allowHelp/pageGuard/daemonUrl/daemonToken/longShot。',
      parameters: {
        action: { type: 'string', required: true, description: 'get | set' },
        label: { type: 'string', description: '实例显示名称。' },
        borrowConfirm: { type: 'boolean', description: '借用前是否人工确认。' },
        allowHelp: { type: 'boolean', description: '是否允许人工协助。' },
        pageGuard: { type: 'boolean', description: '是否启用页面守卫。' },
        daemonUrl: { type: 'string', description: '远程 daemon WS 地址；空字符串恢复本地。' },
        daemonToken: { type: 'string', description: '远程配对 token。' },
        longShot: { type: 'string', description: '长截图模式 auto 或 manual。' },
      },
      async execute(args, exec) {
        if (String(args.action) === 'get') return run(['settings', '--json'], exec);
        if (String(args.action) !== 'set') throw new Error('action 只能是 get|set');
        const argv = ['settings', 'set'];
        if (typeof args.label === 'string') argv.push('--label', args.label);
        if (typeof args.borrowConfirm === 'boolean') argv.push('--borrow-confirm', args.borrowConfirm ? 'on' : 'off');
        if (typeof args.allowHelp === 'boolean') argv.push('--allow-help', args.allowHelp ? 'on' : 'off');
        if (typeof args.pageGuard === 'boolean') argv.push('--page-guard', args.pageGuard ? 'on' : 'off');
        if (typeof args.daemonUrl === 'string') argv.push('--daemon-url', args.daemonUrl);
        if (typeof args.daemonToken === 'string') argv.push('--daemon-token', args.daemonToken);
        if (typeof args.longShot === 'string') argv.push('--long-shot', args.longShot);
        return run(argv, exec);
      },
    },
    {
      name: 'browser_install_skill',
      description: '把内嵌技能安装到指定 Agent 目录（dsh/claude/codex/cursor 等），用于让 Agent 发现 BridgeDeck 的使用说明。',
      parameters: {
        target: { type: 'string', description: 'dsh/claude/codex/cursor 等。' },
        dir: { type: 'string', description: '自定义目录。' },
        force: { type: 'boolean', description: '覆盖已存在的技能目录。' },
      },
      async execute(args, exec) {
        const argv = ['install-skill'];
        if (typeof args.target === 'string') argv.push('--target', args.target);
        if (typeof args.dir === 'string') argv.push('--dir', args.dir);
        if (args.force === true) argv.push('--force');
        return run(argv, exec);
      },
    },
    {
      name: 'browser_brief',
      description: '面向 Agent 的页面简报：URL、refs、截断、待处理对话框与下一步建议。',
      parameters: { sessionId: SESSION },
      async execute(args, exec) {
        return call(['agent', 'brief'], args, exec);
      },
    },
    {
      name: 'browser_tab',
      description: '标签页操作：action=list|new|close|select|move。new 可指定 url/newWindow，move 需 windowId。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | new | close | select | move' },
        tabId: { type: 'integer', description: 'close/select/move 的目标 tabId。' },
        windowId: { type: 'integer', description: 'move 的目标 windowId。' },
        index: { type: 'integer', description: 'move 的目标位置。' },
        url: { type: 'string', description: 'new 的 URL。' },
        newWindow: { type: 'boolean', description: 'new 时是否开新窗口。' },
        noFocus: { type: 'boolean', description: 'new 时是否后台打开。' },
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'list') return run(['tab', 'list', '--json'], exec);
        if (action === 'new') {
          const argv = ['tab', 'new'];
          if (typeof args.url === 'string' && args.url) argv.push(args.url);
          if (args.newWindow === true) argv.push('--window');
          if (args.noFocus === true) argv.push('--no-focus');
          return run(argv, exec);
        }
        if (action === 'close' || action === 'select') {
          if (!Number.isInteger(args.tabId)) throw new Error(action + ' 需要 tabId');
          return run(['tab', action, String(args.tabId)], exec);
        }
        if (action === 'move') {
          if (!Number.isInteger(args.tabId) || !Number.isInteger(args.windowId)) throw new Error('move 需要 tabId 与 windowId');
          return run(['tab', 'move', String(args.tabId), '--to-window', String(args.windowId)], exec);
        }
        throw new Error('action 只能是 list|new|close|select|move');
      },
    },
    {
      name: 'browser_audit',
      description: '读取操作审计记录，支持 limit/offset 分页。',
      parameters: {
        limit: { type: 'integer', description: '返回条数上限。' },
        offset: { type: 'integer', description: '跳过的条数。' },
      },
      async execute(args, exec) {
        const argv = ['audit', 'list'];
        if (Number.isInteger(args.limit)) argv.push('--limit', String(args.limit));
        if (Number.isInteger(args.offset)) argv.push('--offset', String(args.offset));
        return run(argv, exec);
      },
    },
    {
      name: 'browser_tab_new',
      description: '新建标签页，可指定 URL、是否新窗口与是否后台打开。',
      parameters: {
        url: { type: 'string', description: '要打开的 URL。' },
        newWindow: { type: 'boolean', description: '是否在新窗口打开。' },
        noFocus: { type: 'boolean', description: '是否后台打开标签页。' },
      },
      async execute(args, exec) {
        const argv = ['tab', 'new'];
        if (typeof args.url === 'string' && args.url) argv.push(args.url);
        if (args.newWindow === true) argv.push('--window');
        if (args.noFocus === true) argv.push('--no-focus');
        return run(argv, exec);
      },
    },
    {
      name: 'browser_tab_close',
      description: '关闭指定 tabId 的标签页，并清理该标签页的租约与浮动状态。',
      parameters: { tabId: { type: 'integer', required: true, description: '要关闭的 tabId。' } },
      async execute(args, exec) {
        if (!Number.isInteger(args.tabId)) throw new Error('close 需要 tabId');
        return run(['tab', 'close', String(args.tabId)], exec);
      },
    },
    {
      name: 'browser_tab_select',
      description: '激活指定 tabId 的标签页，用于可信输入与反爬场景。',
      parameters: { tabId: { type: 'integer', required: true, description: '要激活的 tabId。' } },
      async execute(args, exec) {
        if (!Number.isInteger(args.tabId)) throw new Error('select 需要 tabId');
        return run(['tab', 'select', String(args.tabId)], exec);
      },
    },
    {
      name: 'browser_network_list',
      description: '列出当前标签页的网络采集记录，可按 URL 子串过滤与限制条数。',
      parameters: {
        filter: { type: 'string', description: 'URL 子串过滤。' },
        limit: { type: 'integer', description: '返回条数上限。' },
      },
      async execute(args, exec) {
        const argv = ['network', 'list'];
        if (typeof args.filter === 'string' && args.filter) argv.push('--filter', args.filter);
        if (Number.isInteger(args.limit)) argv.push('--limit', String(args.limit));
        return run(argv, exec);
      },
    },
    {
      name: 'browser_rule_list',
      description: '列出当前标签页的调试规则、动作、状态与命中次数。',
      parameters: {},
      async execute(args, exec) { return run(['debug', 'rule_list'], exec); },
    },
    {
      name: 'browser_video_status',
      description: '查看当前视频录制状态；异常中断恢复时返回 interrupted 标记。',
      parameters: {},
      async execute(args, exec) { return run(['video', 'status'], exec); },
    },
    {
      name: 'browser_video_list',
      description: '列出已保存的视频录制、字节数与过期时间等容量信息。',
      parameters: {},
      async execute(args, exec) { return run(['video', 'list'], exec); },
    },
    {
      name: 'browser_debug_evidence',
      description: '生成当前调试采集的证据包，包含请求/控制台/性能与 SHA256 完整性摘要。',
      parameters: {},
      async execute(args, exec) { return run(['debug', 'evidence'], exec); },
    },
    {
      name: 'browser_debug_query',
      description: '离线查询 debug export 归档，可按 URL/方法过滤。',
      parameters: {
        file: { type: 'string', required: true, description: 'debug export 的 JSON 文件。' },
        filter: { type: 'string', description: 'URL 子串过滤。' },
      },
      async execute(args, exec) {
        if (typeof args.file !== 'string' || !args.file) throw new Error('query 需要 file');
        const argv = ['debug', 'query', '--file', args.file];
        if (typeof args.filter === 'string' && args.filter) argv.push('--filter', args.filter);
        return run(argv, exec);
      },
    },
    {
      name: 'browser_window',
      description: '窗口路由：action=list|focus|ensure。ensure 复用或创建 Agent 窗口。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | focus | ensure' },
        windowId: { type: 'integer', description: 'focus 的目标 windowId。' },
      },
      async execute(args, exec) {
        const action = String(args.action || '');
        if (action === 'list') return run(['window', 'list', '--json'], exec);
        if (action === 'ensure') return run(['window', 'ensure', '--json'], exec);
        if (action === 'focus') {
          if (!Number.isInteger(args.windowId)) throw new Error('focus 需要 windowId');
          return run(['window', 'focus', String(args.windowId), '--json'], exec);
        }
        throw new Error('action 只能是 list|focus|ensure');
      },
    },
  ];
}
