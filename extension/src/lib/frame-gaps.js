// 帧采集未完成时的分类：隐藏帧 / 文档已失效 / 加载错误。
export function classifyFrameGap({ error = null, hidden = false, message = '' } = {}) {
  if (!error) return null;
  if (hidden === true) return 'hidden_frame';
  const text = String(message || error || '');
  if (/detached|removed|inactive|no document|closed|not found/i.test(text)) return 'inactive_document';
  return 'load_error';
}

function hasOwnUrl(url) {
  const value = String(url || '');
  return Boolean(value) && !/^about:(blank|srcdoc)/i.test(value);
}

/** 向上找第一个有真实 URL 的祖先，返回 URL/帧/深度。 */
function resolveOwner(frame, byId) {
  let current = frame;
  let depth = 0;
  while (current && current.parentFrameId != null) {
    const parent = byId.get(current.parentFrameId);
    if (!parent) break;
    depth += 1;
    if (hasOwnUrl(parent.url)) {
      return { url: parent.url, frameId: parent.frameId, depth, source: depth === 1 ? 'parent_url' : 'ancestor_url' };
    }
    current = parent;
  }
  return { url: '', frameId: null, depth: 0, source: '' };
}

export function summarizeFrameGaps(frames = []) {
  const list = Array.isArray(frames) ? frames : [];
  const byId = new Map(list.filter((frame) => frame && frame.frameId != null).map((frame) => [frame.frameId, frame]));
  const gaps = [];
  let inferred = 0;
  for (const frame of list) {
    const reason = frame && frame.gap;
    if (!reason) continue;
    const ownUrl = hasOwnUrl(frame.url);
    const owner = ownUrl
      ? { url: frame.url, frameId: frame.frameId, depth: 0, source: 'self_url' }
      : (hasOwnUrl(frame.ownerUrl)
        ? { url: frame.ownerUrl, frameId: frame.frameId, depth: 0, source: 'owner_element' }
        : resolveOwner(frame, byId));
    if (owner.url && owner.source !== 'self_url') inferred += 1;
    gaps.push({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      url: frame.url || '',
      ownerUrl: owner.url,
      ownerFrameId: owner.frameId,
      ownerDepth: owner.depth,
      ownerUrlSource: owner.source,
      ownerSrc: frame.ownerSrc || '',
      inferred: Boolean(owner.url) && owner.source !== 'self_url',
      reason,
    });
  }
  const counts = {};
  for (const gap of gaps) counts[gap.reason] = (counts[gap.reason] || 0) + 1;
  return { gaps, counts, inferred };
}
