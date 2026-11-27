// src/runtime/index.ts —— 扩展运行时公共入口（命令路由 + 实例/页面命令 + 设置）。
export { CommandRouter, createCommandRouter } from './router.ts';
export type {
  CommandContext,
  CommandFailure,
  CommandHandler,
  CommandOutcome,
  CommandRegistrationOptions,
  CommandReply,
  CommandRouterOptions,
  DaemonCommandResponder,
  RegisteredCommand,
} from './router.ts';
export {
  AgentWindowRegistry,
  createRuntimeCommands,
  restrictedUrlReason,
} from './commands.ts';
export type {
  BrowserApiLike,
  BrowserTabLike,
  BrowserWindowLike,
  RuntimeCommandsDeps,
  StorageAreaLike,
  TabsLike,
  TabUpdatedListener,
  WindowsLike,
} from './commands.ts';
export {
  daemonSettingsView,
  humanOnlyKeysIn,
  HUMAN_ONLY_KEYS,
  SETTINGS_KEY,
  SettingsStore,
} from './settings.ts';
export type { DaemonSettingsView, SettingsStorage } from './settings.ts';
export {
  COOPERATION_METHODS,
  CooperationRuntime,
  HELP_OVERLAY_HOST_ID,
  HumanWatchStore,
  createCooperationCommands,
  normalizeHelpCriteria,
} from './cooperation.ts';
export type {
  CooperationExtendedDispatch,
  CooperationInjector,
  CooperationRuntimeDeps,
  HumanActivityView,
  HumanReconciliation,
  HumanWatchSnapshot,
} from './cooperation.ts';
