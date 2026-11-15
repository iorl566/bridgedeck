// extension/src/lib/table-facts.js —— 从 AX 树推导表格/网格的 row / col / header 事实。
//
// 目的：page-lib 的 VOM 节点能拿到 role/name，但表格坐标与表头关联需要 AX 层级。
// 这里只做只读推导：table/grid/treegrid → row → cell/columnheader/rowheader，
// 产出 Map<backendNodeId, {row, col, header?, role, headerRow?}>，供 observe 附加到节点。

const TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);

function roleOf(node) {
  return node && typeof node.role === 'string' ? node.role.toLowerCase() : '';
}

export function computeTableFacts(axNodes) {
  const list = Array.isArray(axNodes) ? axNodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node && node.nodeId !== undefined) byId.set(node.nodeId, node);
  }  const childrenOf = new Map();
  for (const node of list) {
    if (!node || node.parentId === undefined || node.parentId === null) continue;
    if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
    childrenOf.get(node.parentId).push(node);
  }
  const isDescendantOf = (node, ancestorId) => {
    let parent = node ? node.parentId : null;
    let guard = 0;
    while (parent !== null && parent !== undefined && guard < 50) {
      if (parent === ancestorId) return true;
      const next = byId.get(parent);
      parent = next ? next.parentId : null;
      guard += 1;
    }
    return false;
  };

  const facts = new Map();
  for (const table of list) {
    if (!TABLE_ROLES.has(roleOf(table))) continue;
    const rows = list.filter((node) => roleOf(node) === 'row'
      && (node.parentId === table.nodeId || isDescendantOf(node, table.nodeId)));
    if (!rows.length) continue;
    const headerRow = rows.find((row) => (childrenOf.get(row.nodeId) || []).some((cell) => roleOf(cell) === 'columnheader')) || null;
    const headers = new Map();
    if (headerRow) {
      const headerCells = (childrenOf.get(headerRow.nodeId) || []).filter((cell) => CELL_ROLES.has(roleOf(cell)));
      headerCells.forEach((cell, index) => headers.set(index, String(cell.name || '')));
    }
    rows.forEach((row, rowIndex) => {
      const cells = (childrenOf.get(row.nodeId) || []).filter((cell) => CELL_ROLES.has(roleOf(cell)));
      cells.forEach((cell, colIndex) => {
        if (!Number.isInteger(cell.backendNodeId)) return;
        const fact = {
          role: cell.role,
          row: rowIndex,
          col: colIndex,
        };
        if (row === headerRow) fact.headerRow = true;
        else if (headers.has(colIndex)) fact.header = headers.get(colIndex);
        facts.set(cell.backendNodeId, fact);
      });
    });
  }
  return facts;
}

/** 汇总每张表/网格的规模与表头，便于调用方快速决策（不依赖 VOM ref）。 */
export function summarizeTables(axNodes) {
  const list = Array.isArray(axNodes) ? axNodes : [];
  const byId = new Map();
  for (const node of list) {
    if (node && node.nodeId !== undefined) byId.set(node.nodeId, node);
  }
  const childrenOf = new Map();
  for (const node of list) {
    if (!node || node.parentId === undefined || node.parentId === null) continue;
    if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
    childrenOf.get(node.parentId).push(node);
  }
  const isDescendantOf = (node, ancestorId) => {
    let parent = node ? node.parentId : null;
    let guard = 0;
    while (parent !== null && parent !== undefined && guard < 50) {
      if (parent === ancestorId) return true;
      const next = byId.get(parent);
      parent = next ? next.parentId : null;
      guard += 1;
    }
    return false;
  };
  const out = [];
  for (const table of list) {
    if (!TABLE_ROLES.has(roleOf(table))) continue;
    const rows = list.filter((node) => roleOf(node) === 'row'
      && (node.parentId === table.nodeId || isDescendantOf(node, table.nodeId)));
    if (!rows.length) continue;
    const headerRow = rows.find((row) => (childrenOf.get(row.nodeId) || []).some((cell) => roleOf(cell) === 'columnheader')) || null;
    const headers = headerRow
      ? (childrenOf.get(headerRow.nodeId) || []).filter((cell) => CELL_ROLES.has(roleOf(cell))).map((cell) => String(cell.name || ''))
      : [];
    out.push({
      role: table.role,
      name: String(table.name || ''),
      rowCount: headerRow ? rows.length - 1 : rows.length,
      colCount: headers.length || Math.max(0, ...rows.map((row) => (childrenOf.get(row.nodeId) || []).filter((cell) => CELL_ROLES.has(roleOf(cell))).length)),
      headers,
    });
  }
  return out;
}
