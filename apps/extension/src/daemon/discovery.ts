// src/daemon/discovery.ts —— daemon 端口候选（多端口发现，M-C 第一批遗留项）。
//
// 背景：0.3.0 JS 扩展在 `extension/src/ws-client.js` 里硬编码 `const PORTS = [52900..52909]`
// 并顺序探测；tools/e2e.mjs 会把那一行改写成它本次 daemon 的端口，从而让同一套验收
// 能指向任意产物目录。TS 产物没有那个源文件，所以本批把“端口候选表”做成一个**部署
// 锚点**：`public/src/ws-client.js`（WXT 会把 public/ 原样复制到产物根目录）只保存一份
// PORTS 常量，background 启动时 fetch 它并解析。这样：
// - E2E/运维可以按需改写产物里的端口列表，而不需要改代码或 E2E 脚本；
// - 默认（读不到/解析失败）回退到与 JS 扩展相同的 52900-52909；
// - 设置里显式配置的 daemonPort 与上次成功连接的端口优先于候选表。
//
// 解析是纯函数（parsePortsAsset），加载函数注入 fetch，单测覆盖 E2E 改写后的单端口文本。

import { DEFAULT_DAEMON_PORT } from '../../shared/constants.ts';

/** 默认端口候选（与 0.3.0 JS 扩展一致）。 */
export const DEFAULT_CANDIDATE_PORTS: readonly number[] = Object.freeze([
  52900, 52901, 52902, 52903, 52904, 52905, 52906, 52907, 52908, 52909,
]);

/** 产物内端口锚点相对路径（WXT public/ → 产物根）。 */
export const PORTS_ASSET_PATH = 'src/ws-client.js';

/** 端口锚点的正则：只认行首的 `const PORTS = [...]`（E2E 改写同一形状；注释不算）。 */
const PORTS_ASSET_PATTERN = /^[ \t]*const\s+PORTS\s*=\s*\[([^\]]*)\]\s*;/m;

/** 合法端口：1–65535 的整数。 */
export function isValidPort(value: unknown): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** 端口列表归一：过滤非法值、去重、保持顺序。 */
export function normalizePortCandidates(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of values) {
    const port = Number(item);
    if (!isValidPort(port) || seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

/**
 * 解析端口锚点文本。
 *
 * @returns 端口数组；找不到 `const PORTS = [...]` 行时返回 null（调用方回退默认表），
 *          行存在但内容非法/为空时返回空数组（明确“没有可用候选”）。
 */
export function parsePortsAsset(text: unknown): number[] | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = PORTS_ASSET_PATTERN.exec(text);
  if (!match || match[1] === undefined) return null;
  const body = match[1];
  return normalizePortCandidates(body.split(',').map((item) => item.trim()).filter(Boolean));
}

export interface CandidateOptions {
  /** 设置里显式配置的 daemonPort（最高优先级；只有用户真的写过才给）。 */
  settingsPort?: number | null;
  /** storage.session 里上次成功连接的端口（次高）。 */
  lastPort?: number | null;
  /** 端口锚点解析结果；null/undefined 表示不可用。 */
  assetPorts?: readonly number[] | null;
  /** 默认候选表（测试可覆盖）。 */
  defaults?: readonly number[];
}

/**
 * 从原始设置对象里取“用户显式配置的 daemonPort”。
 *
 * 为什么不能直接用 normalizeSettings 的结果：它会把缺省值补成 52900，而 52900 也是
 * 端口锚点的第一个候选。如果把它当成“显式配置”，部署/E2E 改写过的锚点就永远排不到
 * 第一位（实测会连到 52900 上的另一个 daemon）。只有存储里真的存在 daemonPort 键才算显式。
 */
export function explicitSettingsPort(rawSettings: unknown): number | null {
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) return null;
  const bag = rawSettings as { daemonPort?: unknown };
  if (!Object.prototype.hasOwnProperty.call(bag, 'daemonPort')) return null;
  const port = Number(bag.daemonPort);
  return isValidPort(port) ? port : null;
}

/**
 * 候选端口顺序：settingsPort → lastPort → 端口锚点（或默认表）→ 兜底默认端口。
 * 结果去重且全部是合法端口；不会返回空数组（至少含默认端口）。
 */
export function resolvePortCandidates(options: CandidateOptions = {}): number[] {
  const ordered: unknown[] = [];
  if (isValidPort(options.settingsPort)) ordered.push(Number(options.settingsPort));
  if (isValidPort(options.lastPort)) ordered.push(Number(options.lastPort));
  const asset = Array.isArray(options.assetPorts) && options.assetPorts.length > 0
    ? options.assetPorts
    : (options.defaults ?? DEFAULT_CANDIDATE_PORTS);
  ordered.push(...asset);
  ordered.push(DEFAULT_DAEMON_PORT);
  const normalized = normalizePortCandidates(ordered);
  return normalized.length > 0 ? normalized : [DEFAULT_DAEMON_PORT];
}

/** 最小 fetch 形状（单测注入；默认用全局 fetch）。 */
export type PortsFetch = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * 读取端口锚点并解析。
 * @returns 解析出的端口数组；任何失败（网络/CSP/格式）都返回 null，由调用方回退默认表。
 */
export async function loadPortsAsset(
  url: string,
  fetchImpl?: PortsFetch,
): Promise<number[] | null> {
  const fetcher = fetchImpl ?? ((input: string) => fetch(input));
  try {
    const response = await fetcher(url);
    if (!response || response.ok !== true) return null;
    const text = await response.text();
    return parsePortsAsset(text);
  } catch {
    return null;
  }
}
