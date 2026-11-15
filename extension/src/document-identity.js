// src/document-identity.js —— 读类操作的文档身份（对齐 bsk read 的证据边界）。
//
// 目的：read/extract 返回的是“当前 DOM 的一次采样”。如果读取期间主文档被替换
//（SPA 重渲染、导航、about:blank→真实页），返回的数据可能混合新旧文档，必须失败
// 而不是把旧 ref/字段交给调用方。
//
// 只在已挂 CDP 的标签页（会话标签页）做校验；借用 tab 未挂调试器时跳过，保持零成本。

import { isAttached, send } from './debugger.js';

/**
 * 读取主文档身份：frameId + documentElement 的 backendNodeId。
 * 未挂 CDP 或页面不可用返回 null（调用方跳过校验）。
 */
export async function readDocumentIdentity(tabId) {
  if (!isAttached(tabId)) return null;
  try {
    const tree = await send(tabId, 'Page.getFrameTree', {});
    const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
    if (!frameId) return null;
    const reply = await send(tabId, 'Runtime.evaluate', {
      expression: 'document.documentElement',
      serializationOptions: {
        serialization: 'deep',
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: 'none' },
      },
    });
    const deep = reply && reply.result && reply.result.deepSerializedValue;
    const backendNodeId = deep && deep.type === 'node' && deep.value ? deep.value.backendNodeId : undefined;
    if (!Number.isInteger(backendNodeId)) return null;
    return { frameId, backendNodeId };
  } catch {
    return null;
  }
}

/** 前后身份一致才算同一次采样。 */
export function sameDocumentIdentity(before, after) {
  if (!before || !after) return false;
  return before.frameId === after.frameId && before.backendNodeId === after.backendNodeId;
}
