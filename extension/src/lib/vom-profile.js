// VOM 预设：给默认过滤/预算提供稳定档位，避免每次手写一堆 flag。
export const VOM_PROFILES = {
  balanced: { minScore: 0, maxNodes: 200, maxTokens: 8000 },
  compact: { minScore: 20, maxNodes: 80, maxTokens: 4000, excludeHidden: true },
  all: {},
};

export function resolveVomProfile(name) {
  const key = String(name || '').trim().toLowerCase();
  return VOM_PROFILES[key] || null;
}
