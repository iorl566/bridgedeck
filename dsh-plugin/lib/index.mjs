// lib/index.mjs —— DSH 插件入口：把 bridge CLI 包装成 browser_* 工具
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRunner } from './bridge.mjs';
import { buildToolSpecs } from './tools.mjs';

export const name = 'browser-bridge-tools';
export const inject = ['tools'];

export const Config = z.object({
  /** bridge CLI 的绝对路径；留空时按插件位置推导，再退回环境变量 BB_CLI。 */
  bridgeCli: z.string().default('').volatile(),
  /** 跑 CLI 的 node 可执行文件；留空用当前进程的 node。 */
  nodePath: z.string().default('').volatile(),
  /** 覆盖 BB_HOME（daemon 状态目录），便于和桌面端隔离。 */
  home: z.string().default('').volatile(),
  /** 单次 CLI 调用超时。 */
  timeoutMs: z.number().default(120000).volatile(),
});

function readConfig(config, key, fallback) {
  const value = config ? config[key] : undefined;
  if (value && typeof value.get === 'function') {
    const inner = value.get();
    return inner === undefined || inner === null || inner === '' ? fallback : inner;
  }
  return value === undefined || value === null || value === '' ? fallback : value;
}

function renderValue(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String((error && error.message) || value);
  }
}

export function apply(ctx, config) {
  const settings = {
    bridgeCli: readConfig(config, 'bridgeCli', ''),
    nodePath: readConfig(config, 'nodePath', ''),
    home: readConfig(config, 'home', ''),
    timeoutMs: Number(readConfig(config, 'timeoutMs', 120000)),
  };

  let run;
  try {
    run = createRunner(settings);
  } catch (error) {
    ctx.logger.warn('BridgeDeck插件未注册工具：%s', (error && error.message) || error);
    return;
  }

  const specs = buildToolSpecs(run);
  for (const spec of specs) {
    ctx.effect(
      () => ctx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
        },
        execute: (args, exec) => spec.execute(args || {}, exec),
      })),
      'browser-bridge-tools:' + spec.name,
    );
  }
  ctx.logger.info('BridgeDeck已注册 %d 个工具', specs.length);
}
