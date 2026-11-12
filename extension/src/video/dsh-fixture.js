import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Exercise packaged DSH tools against a fixture daemon, never the user's daemon.
 * The reference implementation links against its own plugin package; this mirror
 * resolves the local plugin package and reports a clear error when that runtime
 * surface is unavailable.
 */
export async function createDshVideoFixture(executable, env, sessionStateDirectory) {
  const {
    createBskRunner,
    KeyedExecutor,
    ObservationService,
    registerBrowserTools,
    SessionRegistry,
  } = await import(new URL('../../../dsh-plugin/lib/index.mjs', import.meta.url).href);
  if (!createBskRunner || !registerBrowserTools || !SessionRegistry) {
    throw new Error('DSH fixture runtime is not available in this package');
  }
  const definitions = new Map();
  const ctx = {
    get: () => undefined,
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition);
        return () => { definitions.delete(definition.name); };
      },
    },
  };
  const runner = createBskRunner(executable, (command, args, options) => spawn(command, args, { ...options, env: { ...options?.env, ...env } }));
  const registry = new SessionRegistry(2);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx, runner, registry, queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const unregister = registerBrowserTools({
    ctx, runner, registry, queue, observation,
    config: {
      bskPath: executable,
      sessionStateDirectory,
      defaultTimeoutMs: 45000,
      maxSessions: 2,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  });
  return {
    async call(name, args) {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Missing packaged tool: ${name}`);
      return definition.execute(args, { callId: randomUUID(), name, signal: new AbortController().signal });
    },
    async dispose() {
      unregister();
      runner.killAll();
      await observation.dispose();
    },
  };
}
