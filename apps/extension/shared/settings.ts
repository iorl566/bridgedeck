/** 扩展设置（与 0.3.0 JS 栈同名项对齐，M-C 起接管真实读写）。 */
export interface BridgeSettings {
  controlHint: boolean;
  recordOverlay: boolean;
  borrowRequireConfirm: boolean;
  daemonPort: number;
  language: string;
  /** request-help 人工协助卡片是否允许出现（CLI `settings set --allow-help off` 会关闭）。 */
  allowHelp: boolean;
  // -- 人工开关（只能由用户在扩展设置页修改；daemon/CLI 的 settings.set 会 E_FORBIDDEN）--
  /** 实例名（多浏览器区分；设置页可改）。 */
  instanceLabel: string;
  /** 页面守卫：受限页面（浏览器内部页）上禁止动作。 */
  pageGuard: boolean;
  /** 长截图默认模式：auto（自动滚动拼接）/ manual（手动画布）。 */
  longShotMode: 'auto' | 'manual';
  /** 远程配对：daemon 地址（空 = 自动发现本机端口）。 */
  daemonUrl: string;
  /** 远程配对：访问令牌（空 = 未配对）。 */
  daemonToken: string;
  /** 远程配对：6 位配对码（仅配对时使用，保存后由 daemon 校验）。 */
  daemonCode: string;
}

export const DEFAULT_SETTINGS: BridgeSettings = {
  controlHint: true,
  recordOverlay: true,
  borrowRequireConfirm: true,
  daemonPort: 52900,
  language: 'auto',
  allowHelp: true,
  instanceLabel: '',
  pageGuard: true,
  longShotMode: 'auto',
  daemonUrl: '',
  daemonToken: '',
  daemonCode: '',
};

/** 非布尔/非字符串的持久化字段一律回落默认值（不抛异常）。 */
export function normalizeSettings(raw: unknown): BridgeSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<BridgeSettings>;
  return {
    controlHint: typeof input.controlHint === 'boolean' ? input.controlHint : DEFAULT_SETTINGS.controlHint,
    recordOverlay: typeof input.recordOverlay === 'boolean' ? input.recordOverlay : DEFAULT_SETTINGS.recordOverlay,
    borrowRequireConfirm:
      typeof input.borrowRequireConfirm === 'boolean' ? input.borrowRequireConfirm : DEFAULT_SETTINGS.borrowRequireConfirm,
    daemonPort: Number.isInteger(input.daemonPort) && (input.daemonPort as number) > 0 ? (input.daemonPort as number) : DEFAULT_SETTINGS.daemonPort,
    language: typeof input.language === 'string' && input.language.length > 0 ? input.language : DEFAULT_SETTINGS.language,
    allowHelp: typeof input.allowHelp === 'boolean' ? input.allowHelp : DEFAULT_SETTINGS.allowHelp,
    instanceLabel: typeof input.instanceLabel === 'string' ? input.instanceLabel : DEFAULT_SETTINGS.instanceLabel,
    pageGuard: typeof input.pageGuard === 'boolean' ? input.pageGuard : DEFAULT_SETTINGS.pageGuard,
    longShotMode: input.longShotMode === 'manual' ? 'manual' : 'auto',
    daemonUrl: typeof input.daemonUrl === 'string' ? input.daemonUrl : DEFAULT_SETTINGS.daemonUrl,
    daemonToken: typeof input.daemonToken === 'string' ? input.daemonToken : DEFAULT_SETTINGS.daemonToken,
    daemonCode: typeof input.daemonCode === 'string' ? input.daemonCode : DEFAULT_SETTINGS.daemonCode,
  };
}

/** 从 daemonUrl（ws://127.0.0.1:52900/ws）里取端口；非法/空/未写端口返回 null。 */
export function portFromDaemonUrl(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const port = Number(new URL(text).port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    return null;
  } catch {
    return null;
  }
}
