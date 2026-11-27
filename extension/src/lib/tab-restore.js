/** 策略重启恢复：id 优先，id 失效后按 URL 唯一绑定。 */
export function reconcilePolicyRecords(records, tabs) {
  const list = Array.isArray(tabs) ? tabs.filter((tab) => tab && Number.isInteger(tab.id)) : [];
  const byId = new Map(list.map((tab) => [tab.id, tab]));
  const used = new Set();
  const policies = {};
  const unresolved = [];
  for (const [key, record] of Object.entries(records || {})) {
    if (!record) continue;
    const oldId = Number(key);
    const direct = Number.isInteger(oldId) ? byId.get(oldId) : null;
    if (direct && !used.has(direct.id)) {
      policies[direct.id] = record;
      used.add(direct.id);
      continue;
    }
    let matches = list.filter((tab) => tab.url && tab.url === record.url && !used.has(tab.id));
    if (matches.length > 1 && Number.isInteger(record.windowId)) {
      const sameWindow = matches.filter((tab) => tab.windowId === record.windowId);
      if (sameWindow.length === 1) matches = sameWindow;
    }
    if (matches.length === 1) {
      policies[matches[0].id] = record;
      used.add(matches[0].id);
    } else {
      unresolved.push(key);
    }
  }
  return { policies, unresolved };
}

export function reconcileAliasRecords(records, tabs) {
  const list = Array.isArray(tabs) ? tabs.filter((tab) => tab && Number.isInteger(tab.id)) : [];
  const byId = new Map(list.map((tab) => [tab.id, tab]));
  const used = new Set();
  const aliases = {};
  const unresolved = [];
  for (const [alias, record] of Object.entries(records || {})) {
    if (!record || !alias) continue;
    const direct = byId.get(record.tabId);
    if (direct && !used.has(direct.id)) {
      aliases[alias] = { ...record, tabId: direct.id, url: direct.url || record.url || '' };
      used.add(direct.id);
      continue;
    }
    let matches = list.filter((tab) => tab.url && tab.url === record.url && !used.has(tab.id));
    if (matches.length > 1 && Number.isInteger(record.windowId)) {
      const sameWindow = matches.filter((tab) => tab.windowId === record.windowId);
      if (sameWindow.length === 1) matches = sameWindow;
    }
    if (matches.length === 1) {
      aliases[alias] = { ...record, tabId: matches[0].id, url: matches[0].url };
      used.add(matches[0].id);
    } else {
      unresolved.push(alias);
    }
  }
  return { aliases, unresolved };
}
