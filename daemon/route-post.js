// daemon/route-post.js —— 路由后的缓存/别名/提示条处理。

/**
 * 兼容目标 0.5.0 参数对齐：`extract --max-columns` 与 `read --max-nodes` 的**真实**上限执行点。
 *
 * 这两个上限属于“结果形状/规模”约束，由 daemon 在返回前统一裁剪（同一份实现覆盖
 * extract / extract.table / extract.list 与 read），并附 truncated/limits 证据；
 * 不传参数时逐字段不变（默认行为 0 变化）。
 */
function applyResultLimits(route, method, result) {
  if (!result || typeof result !== 'object' || !route || !route.params) return result;
  const params = route.params;
  // extract --max-columns：表格类结果列裁剪（columns 与每行 cells 同步）。
  if ((method === 'extract' || method === 'extract.table' || method === 'extract.list')
    && Array.isArray(result.columns) && Array.isArray(result.rows)) {
    const raw = params.maxColumns !== undefined ? params.maxColumns : params.max_columns;
    const maxColumns = Number.isInteger(raw) && raw > 0 ? raw : null;
    if (maxColumns !== null && result.columns.length > maxColumns) {
      result.columns = result.columns.slice(0, maxColumns);
      result.rows = result.rows.map((row) => (Array.isArray(row) ? row.slice(0, maxColumns) : row));
      result.truncatedColumns = true;
      result.limits = { ...(result.limits || {}), maxColumns };
      result.totalColumns = result.totalColumns !== undefined ? result.totalColumns : result.columns.length + (result.omittedColumns || 0);
    }
  }
  // read --max-nodes：按节点上限裁剪读取结果（fields 即每个被读节点一行）。
  if (method === 'read' && Array.isArray(result.fields)) {
    const raw = params.maxNodes !== undefined ? params.maxNodes : params.max_nodes;
    const maxNodes = Number.isInteger(raw) && raw > 0 ? raw : null;
    if (maxNodes !== null && result.fields.length > maxNodes) {
      result.omittedNodes = result.fields.length - maxNodes;
      result.fields = result.fields.slice(0, maxNodes);
      result.truncated = true;
      result.limits = { ...(result.limits || {}), maxNodes };
    }
  }
  return result;
}

export async function postProcessRoute({ route, method, result, timeoutMs, sendCommand, aliases, crypto }) {
  // 不阻塞导航返回：提示条是可见性 UI，晚一两百毫秒出现不影响动作。
    if (route.session && ['navigate', 'reload', 'navigate-back', 'navigate-forward'].includes(method)) {
      sendCommand(route.instance, 'control-hint', { tabId: route.session.tabId, enabled: true }, 3000).catch(() => {});
    }
    // 页面没变时扩展只回 unchanged（不带全文）：用 daemon 缓存补回文本，省一次大传输。
    if (method === 'observe' && route.session && result && result.unchanged === true) {
      const cached = route.session.observation;
      if (cached && typeof cached.text === 'string') {
        result.observation = cached.text;
        result.cachedFrom = cached.at;
      } else {
        // 缓存缺失（daemon 重启/会话重建）：强制重取一次全文。
        result = await sendCommand(route.instance, 'observe', { ...route.params, force: true }, timeoutMs);
      }
    }
    // observe 结果留在 daemon 里，view 可以直接分段检索，不必重新采集页面。
    if (method === 'observe' && route.session && result && typeof result.observation === 'string') {
      route.session.observation = {
        text: result.observation,
        refs: typeof result.refs === 'number' ? result.refs : 0,
        url: typeof result.url === 'string' ? result.url : route.session.url || '',
        title: typeof result.title === 'string' ? result.title : route.session.title || '',
        at: Date.now(),
      };
    }
    // 短别名：观察/截图结果带回 oN / cN，后续可用 --observation o2 / --capture c1 引用。
    if (route.session && result && typeof result === 'object') {
      if (method === 'observe') {
        if (!result.observationId) result.observationId = 'ob_' + crypto.randomBytes(6).toString('hex');
        const alias = aliases.register(route.session.sessionId, 'observation', result.observationId);
        if (alias) result.observationAlias = alias;
      } else if (method === 'screenshot' && result.capture_id) {
        const alias = aliases.register(route.session.sessionId, 'capture', result.capture_id);
        if (alias) result.captureAlias = alias;
      }
    }
    result = applyResultLimits(route, method, result);

  return result;
}
