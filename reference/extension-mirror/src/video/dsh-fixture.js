import { randomUUID } from 'node:crypto';

/**
 * 用打包后的 DSH 工具跑视频夹具：只连夹具 daemon，绝不碰用户的 daemon。
 *
 * 直接复用本仓库的 DSH 插件入口（`dsh-plugin/lib/index.mjs`）：
 * 提供最小的 ctx（logger / effect / tools.register），让 `apply` 把 browser_* 工具
 * 注册到内存里的工具表，测试时按名字调用。
 */
export async function createDshVideoFixture(executable, env, sessionStateDirectory) {
  const plugin = await import(new URL('../../../../dsh-plugin/lib/index.mjs', import.meta.url).href);
  if (typeof plugin.apply !== 'function') {
    throw new Error('DSH 插件运行时不可用：请确认 dsh-plugin/lib 已随包发布');
  }

  const definitions = new Map();
  const disposers = [];
  const ctx = {
    get: () => undefined,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => { definitions.delete(definition.name); };
      },
    },
  };

  plugin.apply(ctx, {
    bridgeCli: executable,
    nodePath: '',
    home: sessionStateDirectory,
    sessionScope: '',
    timeoutMs: 45000,
  });
  if (!definitions.size) throw new Error('DSH 插件没有注册任何工具');

  return {
    async call(name, args) {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Missing packaged tool: ${name}`);
      return definition.execute(args, { callId: randomUUID(), name, signal: new AbortController().signal });
    },
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* 忽略 */ }
      }
      definitions.clear();
    },
  };
}
