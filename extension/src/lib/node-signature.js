// lib/node-signature.js —— 节点级签名比较（动态读取校验的唯一判定实现）。
//
// 页面级 revision 只能回答“整页有没有变”。节点级校验要回答的是：
// - 观测到的那个节点还在不在（detached）；
// - 它自己的文本/值/属性/状态有没有变（而不是邻居变了）。
//
// 签名由 page-lib 的 node-signature / ref-signatures 产出；这里只做纯比较，便于单测。
// 几何只记录、不阻断：滚动/重排会让 rect 变，但内容没变，读取仍应可用。

/** 会阻断动作/读取的变更种类。 */
export const NODE_BLOCKING_KINDS = ['detached', 'identity', 'text', 'value', 'attributes', 'state'];
/** 只作为证据记录、不阻断的变更种类。 */
export const NODE_ADVISORY_KINDS = ['geometry'];

const IDENTITY_FIELDS = ['tag', 'id', 'name'];
const CONTENT_FIELDS = [
  ['text', 'textHash'],
  ['value', 'valueHash'],
  ['attributes', 'attrsHash'],
];

function addChange(changes, kind, field, before, after) {
  changes.push({ kind, field, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

/**
 * 比较观测时与当前节点的签名。
 * @param {object|null} before 观测时的签名（缺失表示该 ref 没有签名）
 * @param {object} after 当前签名（`present:false` 表示节点已不在文档里）
 * @returns {{changed:boolean, detached:boolean, kinds:string[], blockingKinds:string[], advisoryKinds:string[], changes:object[]}}
 */
export function diffNodeSignatures(before, after) {
  const current = after && typeof after === 'object' ? after : { present: false };
  if (current.present === false) {
    return {
      changed: true,
      detached: true,
      kinds: ['detached'],
      blockingKinds: ['detached'],
      advisoryKinds: [],
      changes: [{ kind: 'detached', field: null, before: null, after: current.code || 'missing' }],
    };
  }
  if (!before || typeof before !== 'object' || before.present === false) {
    return {
      changed: true,
      detached: false,
      kinds: ['identity'],
      blockingKinds: ['identity'],
      advisoryKinds: [],
      changes: [{ kind: 'identity', field: null, before: null, after: 'unobserved' }],
    };
  }

  const changes = [];
  const kinds = new Set();
  for (const field of IDENTITY_FIELDS) {
    if (before[field] !== current[field]) {
      addChange(changes, 'identity', field, before[field], current[field]);
      kinds.add('identity');
    }
  }
  for (const [kind, field] of CONTENT_FIELDS) {
    if (before[field] !== current[field]) {
      addChange(changes, kind, field, before[field], current[field]);
      kinds.add(kind);
    }
  }
  // 文本长度在同一哈希下有差异时也记录下来（帮助排查哈希碰撞）。
  if (before.textLength !== current.textLength && !kinds.has('text')) {
    addChange(changes, 'text', 'textLength', before.textLength, current.textLength);
    kinds.add('text');
  }
  for (const field of ['disabled', 'checked']) {
    if ((before[field] ?? null) !== (current[field] ?? null)) {
      addChange(changes, 'state', field, before[field], current[field]);
      kinds.add('state');
    }
  }
  const beforeGeometry = Array.isArray(before.geometry) ? before.geometry.join(',') : null;
  const afterGeometry = Array.isArray(current.geometry) ? current.geometry.join(',') : null;
  if (beforeGeometry !== afterGeometry) {
    addChange(changes, 'geometry', 'rect', beforeGeometry, afterGeometry);
    kinds.add('geometry');
  }

  return {
    changed: kinds.size > 0,
    detached: false,
    kinds: [...kinds],
    blockingKinds: [...kinds].filter((kind) => NODE_BLOCKING_KINDS.includes(kind)),
    advisoryKinds: [...kinds].filter((kind) => NODE_ADVISORY_KINDS.includes(kind)),
    changes,
  };
}

/** 把签名整理成 `cooperate sync` 对外暴露的摘要（不泄露页面文本内容）。 */
export function summarizeNodeSignatures(signatures) {
  const list = Array.isArray(signatures) ? signatures : [];
  const byHash = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.ref) continue;
    const key = [item.tag, item.id, item.name, item.textHash, item.valueHash, item.attrsHash].join(':');
    const entry = byHash.get(key);
    if (entry) entry.count += 1;
    else byHash.set(key, { key: key, count: 1, tag: item.tag || '', id: item.id || '' });
  }
  return { count: list.length, unique: byHash.size };
}
