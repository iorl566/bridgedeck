// cli/commands/read-drag.mjs —— read/drag/wheel/blur（从 bridge 拆出）。

export function createReadDragCommands(ctx) {
  const { callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson, renderPageBody, renderTable, truncateText, resolveTarget, requirePos, targetOf, parseModifiers, parseDurationMs, intFlag, defaultInputMode, ArgError } = ctx;

function fieldFlags(field) {
    const flags = [];
    if (field.disabled) flags.push('disabled');
    if (field.readonly) flags.push('readonly');
    if (field.required) flags.push('required');
    if (field.checked === true) flags.push('checked');
    return flags.join(',');
  }
  
  function maskFieldValue(field) {
    if (field.type === 'password') return '********';
    if (Array.isArray(field.selectedOptions) && field.selectedOptions.length) {
      return field.selectedOptions.map((item) => item.label || item.value).join(' | ');
    }
    if (Array.isArray(field.files) && field.files.length) return field.files.join(' | ');
    return truncateText(String(field.value == null ? '' : field.value), 60);
  }
  
  
  
  
  
  async function cmdRead(flags, pos) {
    if (flags['closed-shadow-text'] !== undefined) {
      const body = await callRpc('shadow.read', withControl(flags, { text: String(flags['closed-shadow-text']) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print((body.result && body.result.matched) || '');
      return 0;
    }
    const params = withControl(flags, {});
    // 兼容目标 read --max-nodes / --max-bytes：真实进入 read 协议参数（daemon 侧按上限截断结果）。
    if (flags['max-nodes'] !== undefined) params.maxNodes = intFlag(flags, 'max-nodes', { min: 1 });
    if (flags['max-bytes'] !== undefined) params.maxBytes = intFlag(flags, 'max-bytes', { min: 1 });
    if (flags['expect-revision'] !== undefined) {
      const revision = Number(flags['expect-revision']);
      if (!Number.isInteger(revision) || revision < 0) throw new ArgError('--expect-revision 需要 ≥0 的整数（取自 observe/read 的 revision）');
      params.expectRevision = revision;
    }
    if (flags.all === true) {
      params.all = true;
    } else {
      const target = resolveTarget(flags, pos, 1, { required: false });
      if (target) Object.assign(params, target);
    }
    if (flags['fields-json'] !== undefined) {
      let fields;
      try {
        fields = JSON.parse(String(flags['fields-json']));
      } catch (error) {
        throw new ArgError('--fields-json 不是合法 JSON：' + error.message);
      }
      if (!Array.isArray(fields) || !fields.length) throw new ArgError('--fields-json 需要非空数组');
      const target = resolveTarget(flags, pos, 1, { required: true });
      params.fields = fields;
      Object.assign(params, target);
    }
    const body = await callRpc('read', params, timeoutOf(flags));
    return renderPageBody(body, (result) => {
      const fields = Array.isArray(result.fields) ? result.fields : [];
      if (!fields.length) {
        print('(没有可读字段)');
        return;
      }
      print(renderTable(
        ['ref', 'tag', 'type', 'name', 'value', 'flags'],
        fields.map((field) => [
          field.ref || '',
          field.tag || '',
          field.type || '',
          truncateText(field.name || '', 20),
          maskFieldValue(field),
          fieldFlags(field),
        ]),
      ));
    });
  }
  async function cmdDrag(flags, pos) {
    const imageCapture = flags.capture !== undefined;
    const from = pos && pos[1] ? requirePos(pos, 1, '<from>') : undefined;
    if (!imageCapture && !from) {
      throw new ArgError('drag 需要 <from>，或改用 --capture 配 --image-x/--image-y（视觉坐标拖拽）');
    }
    let params = withControl(flags, {});
    if (from) params.from = targetOf(from);
    if (flags.to !== undefined) params.to = targetOf(flags.to);
    if (flags.dx !== undefined) params.dx = Number(flags.dx);
    if (flags.dy !== undefined) params.dy = Number(flags.dy);
  
    // 视觉坐标拖拽：起点用截图里的像素坐标，位移也用图片像素（--image-dx/--image-dy）。
    // 换算成页面坐标由扩展侧完成（含滚动与缩放），模型只需要"看图 → 报坐标"。
    if (imageCapture) {
      if (flags['image-x'] === undefined || flags['image-y'] === undefined) {
        throw new ArgError('drag --capture 需要同时给 --image-x 与 --image-y');
      }
      params.capture = String(flags.capture);
      params.imageX = Number(flags['image-x']);
      params.imageY = Number(flags['image-y']);
      if (flags['image-dx'] !== undefined) params.imageDx = Number(flags['image-dx']);
      if (flags['image-dy'] !== undefined) params.imageDy = Number(flags['image-dy']);
    }
  
    const hasMove = flags.to !== undefined || flags.dx !== undefined || flags.dy !== undefined
      || flags['image-dx'] !== undefined || flags['image-dy'] !== undefined;
    if (!hasMove) {
      throw new ArgError('drag 需要 --to <ref|selector>、--dx/--dy，或 --image-dx/--image-dy');
    }
    if (flags.mode !== undefined) params.mode = String(flags.mode);
    // 兼容目标 drag --observation-id：显式观察基线（visual/untargeted 动作），并复用为 strict 策略的
    // observation 上下文（扩展 control.js 只认 params.observation）。
    if (flags['observation-id'] !== undefined) {
      const observationId = String(flags['observation-id']);
      params.observationId = observationId;
      if (params.observation === undefined) params.observation = observationId;
    }
    // 兼容目标 drag --button：left|middle|right，真实进入 drag 协议参数（扩展 trusted 路径按 button 分流）。
    if (flags.button !== undefined) {
      const button = String(flags.button).toLowerCase();
      if (!['left', 'middle', 'right'].includes(button)) {
        throw new ArgError('--button 只支持 left|middle|right，收到 "' + flags.button + '"');
      }
      params.button = button;
    }
    if (flags.modifiers !== undefined) params.modifiers = parseModifiers(flags.modifiers);
    const steps = intFlag(flags, 'steps', { min: 2 });
    if (steps !== undefined) params.steps = steps;
    params.holdMs = parseDurationMs(flags.hold, 0);
    params.durationMs = parseDurationMs(flags.duration, 0);
    params = defaultInputMode(params, flags);
    if (flags.force === true) params.force = true;
    for (const key of ['from-offset-x', 'from-offset-y', 'to-offset-x', 'to-offset-y']) {
      if (flags[key] !== undefined) {
        const map = {
          'from-offset-x': 'fromOffsetX',
          'from-offset-y': 'fromOffsetY',
          'to-offset-x': 'toOffsetX',
          'to-offset-y': 'toOffsetY',
        };
        params[map[key]] = Number(flags[key]);
      }
    }
    const body = await callRpc('drag', params, timeoutOf(flags));
    return renderPageBody(body, (result) => {
      print('ok（' + (result.mode || 'hold') + '，' + (result.points || 0) + ' 个移动点）');
    });
  }
  
  async function cmdWheel(flags, pos) {
    const deltaY = intFlag(flags, 'delta-y', { min: -1000000 });
    const deltaX = intFlag(flags, 'delta-x', { min: -1000000 });
    if (deltaY === undefined && deltaX === undefined) throw new ArgError('wheel 需要 --delta-y 或 --delta-x');
    const params = withControl(flags, {});
    if (deltaY !== undefined) params.deltaY = deltaY;
    if (deltaX !== undefined) params.deltaX = deltaX;
    const target = resolveTarget(flags, pos, 1, { required: false });
    if (target) Object.assign(params, target);
    const body = await callRpc('wheel', params, timeoutOf(flags));
    return renderPageBody(body, (result) => {
      print('scrollY=' + (result.scrollY || 0) + (result.synthetic ? '（合成事件未触发页面滚动，已退化为 scrollBy）' : ''));
    });
  }
  
  async function cmdBlur(flags, pos) {
    const params = withControl(flags, {});
    const target = resolveTarget(flags, pos, 1, { required: false });
    if (target) Object.assign(params, target);
    const body = await callRpc('blur', params, timeoutOf(flags));
    return renderPageBody(body, () => print('ok'));
  }
  return { cmdRead, cmdDrag, cmdWheel, cmdBlur };
}
