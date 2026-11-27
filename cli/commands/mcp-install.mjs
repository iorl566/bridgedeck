// cli/commands/mcp-install.mjs —— mcp-install（从 bridge 拆出）。
import path from 'node:path';

export async function mcpInstallCommand(ctx, flags) {
  const { REPO_ROOT, ArgError, emitJson, isJson, print } = ctx;

async function cmdMcpInstall(flags) {  const { installJsonMcp, installTomlMcp, installYamlMcp, installDshMcp, serverForClient } = await import('../mcp-config.mjs');
    const supported = ['claude', 'claude-desktop', 'cursor', 'opencode', 'vscode', 'vscode-insiders', 'windsurf', 'kilo', 'amp', 'copilot', 'kiro', 'qwen', 'codebuddy', 'cortex', 'pi', 'qoder', 'warp', 'junie', 'kimi', 'lm-studio', 'trae', 'trae-cn', 'cline', 'roo-cline', 'augment', 'codex', 'grok', 'goose', 'hermes', 'dsh'];
    const raw = flags.client === undefined ? supported.join(',') : String(flags.client);
    const selected = raw === 'all' ? supported.slice() : raw.split(',').map((item) => item.trim()).filter(Boolean);
    for (const client of selected) {
      if (!supported.includes(client)) throw new ArgError('--client 只能取 ' + supported.join('|') + '（或 all）');
    }
    const base = { command: process.execPath, args: [path.join(REPO_ROOT, 'cli', 'bridge.mjs'), 'mcp'] };
    const results = [];
    for (const client of selected) {
      try {
        const server = serverForClient(client, base);
        const result = client === 'codex' || client === 'grok'
          ? installTomlMcp(client, server, { dryRun: flags['dry-run'] === true })
          : client === 'goose' || client === 'hermes'
            ? installYamlMcp(client, server, { dryRun: flags['dry-run'] === true })
            : client === 'dsh'
              ? installDshMcp(server, { dryRun: flags['dry-run'] === true })
              : installJsonMcp(client, server, { dryRun: flags['dry-run'] === true });
        results.push({ kind: 'mcp', ...result });
      } catch (error) {
        results.push({ kind: 'mcp', client, status: 'error', path: null, error: String((error && error.message) || error) });
      }
    }
    if (isJson()) {
      emitJson({ ok: results.every((row) => row.status !== 'conflict' && row.status !== 'error'), result: { clients: results, dryRun: flags['dry-run'] === true } });
      return results.some((row) => row.status === 'conflict' || row.status === 'error') ? 1 : 0;
    }
    for (const row of results) {
      const suffix = row.status === 'installed' && flags['dry-run'] === true ? '（dry-run，未写入）' : '';
      print('MCP ' + row.client + ' → ' + (row.path || '-') + '（' + row.status + '）' + suffix);
      if (row.error) print('  ' + row.error);
    }
    return results.some((row) => row.status === 'conflict' || row.status === 'error') ? 1 : 0;
  }
  return await cmdMcpInstall(flags);
}
