/**
 * Remove unreachable frames and every subtree below them from the routing
 * surface.
 *
 * A frame named in `unavailable` is reported as a gap rather than silently
 * dropped: `unavailableFrames` keeps its frame record together with the target
 * that failed. Descendants inherit the omission even when the input graph still
 * listed them, because a child of a failed frame cannot be addressed reliably.
 * The input graph and the map are not modified. When nothing is unavailable the
 * same graph object is returned, so callers may compare identity to detect a
 * no-op projection.
 * @param {import('./chromium-cdp.js').CdpFrameGraph} graph Discovered frames.
 * @param {ReadonlyMap<string, import('./chromium-cdp.js').CdpTarget>} unavailable
 *   Frame ids that cannot be queried, mapped to the target that failed.
 * @returns {import('./chromium-cdp.js').CdpFrameGraph} Projected graph whose
 *   `frames` excludes the unavailable subtrees.
 */
export function omitFrameSubtrees(graph, unavailable) {
  if (!unavailable.size) return graph;
  const blocked = new Set(unavailable.keys());
  const children = new Map();
  for (const frame of graph.frames) {
    if (!frame.parentFrameId) continue;
    const siblings = children.get(frame.parentFrameId) ?? [];
    siblings.push(frame.frameId);
    children.set(frame.parentFrameId, siblings);
  }
  const queue = [...blocked];
  for (let i = 0; i < queue.length; i += 1) {
    for (const child of children.get(queue[i]) ?? []) {
      if (blocked.has(child)) continue;
      blocked.add(child);
      queue.push(child);
    }
  }
  const omitted = new Map(graph.frames.filter((frame) => blocked.has(frame.frameId)).map((frame) => [frame.frameId, frame]));
  for (const [frameId, target] of unavailable) omitted.set(frameId, { ...omitted.get(frameId), frameId, target });
  return {
    ...graph,
    frames: graph.frames.filter((frame) => !blocked.has(frame.frameId)),
    unavailableFrames: [...omitted.values()],
  };
}

/**
 * Stable routing key for one debugger target.
 *
 * A tab can have one top-level target and any number of frame sessions that
 * report the same `tabId`. The session id disambiguates them, and the literal
 * `root` keeps the key well-formed when no session id was assigned.
 *
 * @param {import('./chromium-cdp.js').CdpTarget} target Debugger target.
 * @returns {string} Key in the form `<tabId>:<sessionId|root>`.
 */
export function cdpTargetKey(target) {
  return `${target.tabId}:${target.sessionId ?? 'root'}`;
}
/**
 * Merge one tree node into the accumulated frame map.
 *
 * Existing metadata wins over absent fields, so a later source that only knows
 * a frame id cannot erase a parent or URL discovered earlier. New frames are
 * appended to `order` exactly once.
 *
 * @param {Map<string, import('./chromium-cdp.js').CdpFrame>} frames Accumulator.
 * @param {string[]} order Discovery order of frame ids.
 * @param {{ frame: { id: string, parentId?: string, url?: string } }} node Tree node.
 * @param {import('./chromium-cdp.js').CdpTarget} target Target owning the node.
 * @returns {void}
 */
function mergeFrame(frames, order, node, target) {
  const existing = frames.get(node.frame.id);
  if (!existing) order.push(node.frame.id);
  const parentFrameId = node.frame.parentId || existing?.parentFrameId;
  const url = node.frame.url || existing?.url;
  frames.set(node.frame.id, {
    frameId: node.frame.id,
    ...(parentFrameId ? { parentFrameId } : {}),
    ...(url ? { url } : {}),
    target,
  });
}

/**
 * Walk one frame tree depth-first without recursing.
 *
 * The target for a node comes from `targetByRootFrameId` when the node is a tree
 * root, otherwise from the nearest ancestor's target. Nodes are visited once per
 * walk; the shared `expanded` set prevents a malformed tree that repeats a node
 * from looping forever. Children are pushed in reverse so discovery order matches
 * document order.
 *
 * @param {import('./chromium-cdp.js').CdpFrameTreeSource} source Root tree.
 * @param {ReadonlyMap<string, import('./chromium-cdp.js').CdpTarget>} targetByRootFrameId
 *   Target to use for each session's root frame.
 * @param {Map<string, import('./chromium-cdp.js').CdpFrame>} frames Accumulator.
 * @param {string[]} order Discovery order of frame ids.
 * @returns {void}
 */
function walkFrameTree(source, targetByRootFrameId, frames, order) {
  const stack = [{ node: source.tree, inheritedTarget: source.target }];
  const expanded = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || expanded.has(current.node)) continue;
    expanded.add(current.node);
    const target = targetByRootFrameId.get(current.node.frame.id) ?? current.inheritedTarget;
    mergeFrame(frames, order, current.node, target);
    const children = current.node.childFrames ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], inheritedTarget: target });
  }
}

/**
 * Build one graph from the frame trees of a tab and its child sessions.
 *
 * The source without a session id is the top-level tree and supplies
 * `rootFrameId`. It is walked first, then each child tree in the given order.
 * A frame claimed by two sources keeps one record; the top-level source is
 * authoritative when malformed input reports the same frame as both a root
 * target and a child target. Discovery order is preserved, and duplicate ids
 * appear once.
 *
 * @param {import('./chromium-cdp.js').CdpFrameTreeSource[]} sources Frame trees
 *   of one tab, in discovery order.
 * @returns {import('./chromium-cdp.js').CdpFrameGraph | null} Graph, or null
 *   when no source was supplied.
 */
export function buildFrameGraph(sources) {
  const rootSource = sources.find((source) => source.target.sessionId === undefined) ?? sources[0];
  if (!rootSource) return null;
  const frames = new Map();
  const order = [];
  const targetByRootFrameId = new Map(sources.map((source) => [source.tree.frame.id, source.target]));
  targetByRootFrameId.set(rootSource.tree.frame.id, rootSource.target);
  walkFrameTree(rootSource, targetByRootFrameId, frames, order);
  for (const source of sources) {
    if (source === rootSource) continue;
    walkFrameTree(source, targetByRootFrameId, frames, order);
  }
  return {
    rootFrameId: rootSource.tree.frame.id,
    frames: order.flatMap((frameId) => (frames.has(frameId) ? [frames.get(frameId)] : [])),
  };
}
