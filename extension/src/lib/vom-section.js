// 语义 section：从祖先链找最近的 landmark（main/nav/header/footer/form）。
export function landmarkSection(ancestors) {
  const list = Array.isArray(ancestors) ? ancestors : [];
  const found = list.find((item) => {
    const role = String((item && item.role) || '');
    const tag = String((item && item.tag) || '');
    return ['main', 'navigation', 'banner', 'contentinfo', 'region', 'form'].includes(role)
      || ['main', 'nav', 'header', 'footer', 'form'].includes(tag);
  });
  if (!found) return null;
  return {
    role: found.role || null,
    tag: found.tag || null,
    id: found.id || null,
    ref: found.ref || null,
  };
}

/** 行锚点：从祖先链找最近的 tr/role=row，用于表格/列表行归因。 */
export function rowAnchor(ancestors) {
  const list = Array.isArray(ancestors) ? ancestors : [];
  const found = list.find((item) => String((item && item.tag) || '').toLowerCase() === 'tr' || String((item && item.role) || '') === 'row');
  if (!found) return null;
  return { tag: found.tag || null, role: found.role || null, id: found.id || null, ref: found.ref || null };
}

/** 表单锚点：从祖先链找最近的 form/role=form。 */
export function formAnchor(ancestors) {
  const list = Array.isArray(ancestors) ? ancestors : [];
  const found = list.find((item) => String((item && item.tag) || '').toLowerCase() === 'form' || String((item && item.role) || '') === 'form');
  if (!found) return null;
  return { tag: found.tag || null, role: found.role || null, id: found.id || null, ref: found.ref || null };
}
