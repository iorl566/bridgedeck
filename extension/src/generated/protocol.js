// 由 tools/gen-protocol.mjs 生成，请勿手改；运行 node tools/gen-protocol.mjs 重新生成。
export const GENERATED_PROTOCOL = true;
export const METHOD_EFFECT = {
  "session.start": "control_plane",
  "session.start_tracked": "control_plane",
  "session.request_prepare": "control_plane",
  "session.request_claim": "control_plane",
  "session.request_cancel": "control_plane",
  "session.request_status": "passive_read",
  "session.stop": "control_plane",
  "session.stop_all": "control_plane",
  "session.run_log": "passive_read",
  "session.list": "control_plane",
  "session.rebind": "control_plane",
  "session.pause": "control_plane",
  "session.resume": "control_plane",
  "session.control_status": "control_plane",
  "session.claim_control": "control_plane",
  "session.release_control": "control_plane",
  "session.handoff": "control_plane",
  "session.control_mode": "control_plane",
  "browsers": "control_plane",
  "status": "control_plane",
  "settings.get": "control_plane",
  "settings.set": "control_plane",
  "pair.create": "control_plane",
  "pair.list": "control_plane",
  "pair.redeem": "control_plane",
  "pair.revoke": "control_plane",
  "pair.renew": "control_plane",
  "local.pair": "control_plane",
  "local.trust": "control_plane",
  "audit.list": "control_plane",
  "operations.list": "control_plane",
  "operations.get": "control_plane",
  "daemon.stop": "control_plane",
  "video.list": "control_plane",
  "video.prune": "control_plane",
  "record.list": "control_plane",
  "debug.history": "control_plane",
  "debug.delete": "control_plane",
  "diagnostics.ui": "control_plane",
  "transfer.begin": "control_plane",
  "transfer.chunk": "control_plane",
  "transfer.finish": "control_plane",
  "transfer.read": "control_plane",
  "transfer.release": "control_plane",
  "observe": "passive_read",
  "observe-frames": "passive_read",
  "snapshot": "passive_read",
  "get-html": "passive_read",
  "read": "passive_read",
  "view": "passive_read",
  "extract": "passive_read",
  "extract.discover": "passive_read",
  "extract.table": "passive_read",
  "extract.list": "passive_read",
  "console": "passive_read",
  "network.list": "passive_read",
  "network.detail": "passive_read",
  "screenshot": "passive_read",
  "screenshot.read": "passive_read",
  "screenshot.release": "passive_read",
  "debug.current": "passive_read",
  "debug.request": "passive_read",
  "debug.performance": "passive_read",
  "debug.coverage": "passive_read",
  "cooperate.sync": "passive_read",
  "hover": "transient_input",
  "navigate": "browser_mutation",
  "reload": "browser_mutation",
  "navigate-back": "browser_mutation",
  "navigate-forward": "browser_mutation",
  "click": "browser_mutation",
  "click-backend": "browser_mutation",
  "fill": "browser_mutation",
  "press": "browser_mutation",
  "select": "browser_mutation",
  "focus": "browser_mutation",
  "blur": "browser_mutation",
  "scroll-to": "browser_mutation",
  "wheel": "browser_mutation",
  "drag": "browser_mutation",
  "upload": "browser_mutation",
  "download": "browser_mutation",
  "evaluate": "browser_mutation",
  "webmcp.list": "read",
  "webmcp.call": "browser_mutation",
  "emulate": "browser_mutation",
  "network.start": "browser_mutation",
  "network.stop": "browser_mutation",
  "debug.start": "browser_mutation",
  "debug.stop": "browser_mutation",
  "trace.start": "browser_mutation",
  "trace.stop": "browser_mutation",
  "trace.status": "passive_read",
  "pdf": "passive_read",
  "refs.negotiate": "passive_read",
  "longshot.recover": "passive_read",
  "record.start": "browser_mutation",
  "record.stop": "browser_mutation",
  "video.start": "browser_mutation",
  "video.stop": "browser_mutation",
  "request-help": "browser_mutation",
  "cooperate.wait": "control_plane",
  "cooperate.handback": "control_plane",
  "cooperate.hold": "control_plane",
  "dialog.arm": "browser_mutation",
  "dialog.disarm": "browser_mutation",
  "dialog.accept": "browser_mutation",
  "dialog.dismiss": "browser_mutation",
  "tab.list": "control_plane",
  "tab.new": "browser_mutation",
  "tab.policy": "control_plane",
  "tab.alias": "control_plane",
  "tab.cleanup": "browser_mutation",
  "tab.close": "browser_mutation",
  "tab.select": "browser_mutation",
  "tab.move": "browser_mutation",
  "tab.borrow": "browser_mutation",
  "tab.return": "browser_mutation",
  "window.list": "control_plane",
  "window.close": "browser_mutation",
  "window.focus": "browser_mutation",
  "window.resize": "browser_mutation",
  "dialog.list": "control_plane",
  "dialog.status": "control_plane",
  "dialog.handle": "browser_mutation",
  "video.status": "control_plane",
  "video.fetch": "browser_mutation",
  "video.recover": "browser_mutation",
  "video.verify": "read",
  "video.discard": "browser_mutation",
  "record.status": "control_plane",
  "network.replay": "browser_mutation",
  "network.waterfall": "passive_read",
  "debug.capabilities": "control_plane",
  "debug.pin": "browser_mutation",
  "debug.pinned": "control_plane",
  "debugger.detach": "browser_mutation",
  "debugger.simulate-detach": "browser_mutation",
  "screenshot.manual.start": "browser_mutation",
  "screenshot.manual.frame": "browser_mutation",
  "screenshot.manual.save": "browser_mutation",
  "shadow.click": "browser_mutation",
  "shadow.read": "passive_read",
  "click-point": "browser_mutation",
  "control-hint": "browser_mutation",
  "ui.open": "control_plane",
  "operation.await": "passive_read",
  "operation.cancel": "control_plane",
  "wait-ms": "passive_read",
  "wait-for-element": "passive_read",
  "wait-for-navigation": "passive_read",
  "actionable": "passive_read",
  "plan": "control_plane",
  "step": "browser_mutation",
  "debug.rule_add": "browser_mutation",
  "debug.rule_clear": "browser_mutation",
  "debug.rule_enable": "browser_mutation",
  "debug.rule_disable": "browser_mutation",
  "debug.rule_remove": "browser_mutation",
  "debug.rule_import": "browser_mutation",
  "debug.rule_list": "passive_read",
  "debug.rule_export": "passive_read",
  "debug.fetch_probe": "browser_mutation",
  "window.ensureAgent": "browser_mutation",
  "window.newAgent": "browser_mutation"
};
export const METHODS = [
  "actionable",
  "audit.list",
  "blur",
  "browsers",
  "click",
  "click-backend",
  "click-point",
  "console",
  "control-hint",
  "cooperate.handback",
  "cooperate.hold",
  "cooperate.sync",
  "cooperate.wait",
  "daemon.stop",
  "debug.capabilities",
  "debug.coverage",
  "debug.current",
  "debug.delete",
  "debug.fetch_probe",
  "debug.history",
  "debug.performance",
  "debug.pin",
  "debug.pinned",
  "debug.request",
  "debug.rule_add",
  "debug.rule_clear",
  "debug.rule_disable",
  "debug.rule_enable",
  "debug.rule_export",
  "debug.rule_import",
  "debug.rule_list",
  "debug.rule_remove",
  "debug.start",
  "debug.stop",
  "debugger.detach",
  "debugger.simulate-detach",
  "diagnostics.ui",
  "dialog.accept",
  "dialog.arm",
  "dialog.disarm",
  "dialog.dismiss",
  "dialog.handle",
  "dialog.list",
  "dialog.status",
  "download",
  "drag",
  "emulate",
  "evaluate",
  "extract",
  "extract.discover",
  "extract.list",
  "extract.table",
  "fill",
  "focus",
  "get-html",
  "hover",
  "local.pair",
  "local.trust",
  "longshot.recover",
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "network.waterfall",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "operations.get",
  "operations.list",
  "pair.create",
  "pair.list",
  "pair.redeem",
  "pair.renew",
  "pair.revoke",
  "pdf",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "refs.negotiate",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "screenshot.read",
  "screenshot.release",
  "scroll-to",
  "select",
  "session.claim_control",
  "session.control_mode",
  "session.control_status",
  "session.handoff",
  "session.list",
  "session.pause",
  "session.rebind",
  "session.release_control",
  "session.request_cancel",
  "session.request_claim",
  "session.request_prepare",
  "session.request_status",
  "session.resume",
  "session.run_log",
  "session.start",
  "session.start_tracked",
  "session.stop",
  "session.stop_all",
  "settings.get",
  "settings.set",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "status",
  "step",
  "tab.alias",
  "tab.borrow",
  "tab.cleanup",
  "tab.close",
  "tab.list",
  "tab.move",
  "tab.new",
  "tab.policy",
  "tab.return",
  "tab.select",
  "trace.start",
  "trace.status",
  "trace.stop",
  "transfer.begin",
  "transfer.chunk",
  "transfer.finish",
  "transfer.read",
  "transfer.release",
  "ui.open",
  "upload",
  "video.discard",
  "video.fetch",
  "video.list",
  "video.prune",
  "video.recover",
  "video.start",
  "video.status",
  "video.stop",
  "video.verify",
  "view",
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
  "webmcp.call",
  "webmcp.list",
  "wheel",
  "window.close",
  "window.ensureAgent",
  "window.focus",
  "window.list",
  "window.newAgent",
  "window.resize"
];
export const MUTATING_METHODS = new Set([
  "blur",
  "click",
  "click-backend",
  "click-point",
  "control-hint",
  "debug.fetch_probe",
  "debug.pin",
  "debug.rule_add",
  "debug.rule_clear",
  "debug.rule_disable",
  "debug.rule_enable",
  "debug.rule_import",
  "debug.rule_remove",
  "debug.start",
  "debug.stop",
  "debugger.detach",
  "debugger.simulate-detach",
  "dialog.accept",
  "dialog.arm",
  "dialog.disarm",
  "dialog.dismiss",
  "dialog.handle",
  "download",
  "drag",
  "emulate",
  "evaluate",
  "fill",
  "focus",
  "hover",
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.replay",
  "network.start",
  "network.stop",
  "plan",
  "press",
  "record.start",
  "record.stop",
  "reload",
  "request-help",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "scroll-to",
  "select",
  "session.pause",
  "session.rebind",
  "session.start",
  "session.start_tracked",
  "session.stop",
  "shadow.click",
  "step",
  "tab.borrow",
  "tab.cleanup",
  "tab.close",
  "tab.move",
  "tab.new",
  "tab.return",
  "tab.select",
  "trace.start",
  "trace.stop",
  "upload",
  "video.discard",
  "video.fetch",
  "video.recover",
  "video.start",
  "video.stop",
  "webmcp.call",
  "wheel",
  "window.close",
  "window.ensureAgent",
  "window.focus",
  "window.newAgent",
  "window.resize"
]);
export const LOCAL_METHODS = new Set([
  "audit.list",
  "browsers",
  "cancel",
  "command.cancel",
  "daemon.stop",
  "inflight.list",
  "ledger.request",
  "ledger.resolve",
  "ledger.status",
  "local.pair",
  "local.trust",
  "operations.get",
  "operations.list",
  "pair.create",
  "pair.list",
  "pair.redeem",
  "pair.renew",
  "pair.revoke",
  "pair.rotate",
  "session.claim_control",
  "session.control_mode",
  "session.control_status",
  "session.handoff",
  "session.list",
  "session.pause",
  "session.rebind",
  "session.release_control",
  "session.request_cancel",
  "session.request_claim",
  "session.request_prepare",
  "session.request_status",
  "session.resume",
  "session.run_log",
  "session.start",
  "session.start_tracked",
  "session.stop",
  "session.stop_all",
  "settings.get",
  "settings.set",
  "status",
  "transfer.begin",
  "transfer.chunk",
  "transfer.finish",
  "transfer.read",
  "transfer.release",
  "view"
]);
export const SESSION_METHODS = new Set([
  "actionable",
  "blur",
  "click",
  "click-backend",
  "click-point",
  "console",
  "cooperate.handback",
  "cooperate.hold",
  "cooperate.sync",
  "cooperate.wait",
  "debug.capabilities",
  "debug.coverage",
  "debug.current",
  "debug.delete",
  "debug.fetch_probe",
  "debug.history",
  "debug.performance",
  "debug.pin",
  "debug.pinned",
  "debug.request",
  "debug.rule_add",
  "debug.rule_clear",
  "debug.rule_disable",
  "debug.rule_enable",
  "debug.rule_export",
  "debug.rule_import",
  "debug.rule_list",
  "debug.rule_remove",
  "debug.start",
  "debug.stop",
  "dialog.accept",
  "dialog.arm",
  "dialog.disarm",
  "dialog.dismiss",
  "dialog.handle",
  "dialog.list",
  "dialog.status",
  "download",
  "drag",
  "emulate",
  "evaluate",
  "extract",
  "extract.discover",
  "extract.list",
  "extract.table",
  "fill",
  "focus",
  "get-html",
  "hover",
  "longshot.recover",
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "network.waterfall",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "pdf",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "refs.negotiate",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "screenshot.read",
  "screenshot.release",
  "scroll-to",
  "select",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "step",
  "tab.borrow",
  "tab.policy",
  "tab.return",
  "trace.start",
  "trace.status",
  "trace.stop",
  "upload",
  "video.discard",
  "video.fetch",
  "video.list",
  "video.prune",
  "video.recover",
  "video.start",
  "video.status",
  "video.stop",
  "video.verify",
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
  "webmcp.call",
  "webmcp.list",
  "wheel",
  "window.resize"
]);
export const INSTANCE_METHODS = new Set([
  "control-hint",
  "debugger.detach",
  "debugger.simulate-detach",
  "diagnostics.ui",
  "tab.alias",
  "tab.cleanup",
  "tab.close",
  "tab.list",
  "tab.move",
  "tab.new",
  "tab.select",
  "ui.open",
  "window.close",
  "window.ensureAgent",
  "window.focus",
  "window.list",
  "window.newAgent"
]);
export const EXT_METHODS = new Set([
  "actionable",
  "blur",
  "click",
  "click-backend",
  "click-point",
  "console",
  "control-hint",
  "cooperate.handback",
  "cooperate.hold",
  "cooperate.sync",
  "cooperate.wait",
  "debug.capabilities",
  "debug.coverage",
  "debug.current",
  "debug.delete",
  "debug.fetch_probe",
  "debug.history",
  "debug.performance",
  "debug.pin",
  "debug.pinned",
  "debug.request",
  "debug.rule_add",
  "debug.rule_clear",
  "debug.rule_disable",
  "debug.rule_enable",
  "debug.rule_export",
  "debug.rule_import",
  "debug.rule_list",
  "debug.rule_remove",
  "debug.start",
  "debug.stop",
  "debugger.detach",
  "debugger.simulate-detach",
  "diagnostics.ui",
  "dialog.accept",
  "dialog.arm",
  "dialog.disarm",
  "dialog.dismiss",
  "dialog.handle",
  "dialog.list",
  "dialog.status",
  "download",
  "drag",
  "emulate",
  "evaluate",
  "extract",
  "extract.discover",
  "extract.list",
  "extract.table",
  "fill",
  "focus",
  "get-html",
  "hover",
  "longshot.recover",
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "network.waterfall",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "pdf",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "refs.negotiate",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "screenshot.read",
  "screenshot.release",
  "scroll-to",
  "select",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "step",
  "tab.alias",
  "tab.borrow",
  "tab.cleanup",
  "tab.close",
  "tab.list",
  "tab.move",
  "tab.new",
  "tab.policy",
  "tab.return",
  "tab.select",
  "trace.start",
  "trace.status",
  "trace.stop",
  "ui.open",
  "upload",
  "video.discard",
  "video.fetch",
  "video.list",
  "video.prune",
  "video.recover",
  "video.start",
  "video.status",
  "video.stop",
  "video.verify",
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
  "webmcp.call",
  "webmcp.list",
  "wheel",
  "window.close",
  "window.ensureAgent",
  "window.focus",
  "window.list",
  "window.newAgent",
  "window.resize"
]);
export const METHOD_COUNT = 165;
export const METHOD_OWNER = {
  "session.start": "local",
  "session.start_tracked": "local",
  "session.request_prepare": "local",
  "session.request_claim": "local",
  "session.request_cancel": "local",
  "session.request_status": "local",
  "session.stop": "local",
  "session.stop_all": "local",
  "session.run_log": "local",
  "session.list": "local",
  "session.rebind": "local",
  "session.pause": "local",
  "session.resume": "local",
  "session.control_status": "local",
  "session.claim_control": "local",
  "session.release_control": "local",
  "session.handoff": "local",
  "session.control_mode": "local",
  "browsers": "local",
  "status": "local",
  "settings.get": "local",
  "settings.set": "local",
  "pair.create": "local",
  "pair.list": "local",
  "pair.redeem": "local",
  "pair.revoke": "local",
  "pair.renew": "local",
  "local.pair": "local",
  "local.trust": "local",
  "audit.list": "local",
  "operations.list": "local",
  "operations.get": "local",
  "daemon.stop": "local",
  "video.list": "session",
  "video.prune": "session",
  "record.list": "session",
  "debug.history": "session",
  "debug.delete": "session",
  "diagnostics.ui": "instance",
  "transfer.begin": "local",
  "transfer.chunk": "local",
  "transfer.finish": "local",
  "transfer.read": "local",
  "transfer.release": "local",
  "observe": "session",
  "observe-frames": "session",
  "snapshot": "session",
  "get-html": "session",
  "read": "session",
  "view": "local",
  "extract": "session",
  "extract.discover": "session",
  "extract.table": "session",
  "extract.list": "session",
  "console": "session",
  "network.list": "session",
  "network.detail": "session",
  "screenshot": "session",
  "screenshot.read": "session",
  "screenshot.release": "session",
  "debug.current": "session",
  "debug.request": "session",
  "debug.performance": "session",
  "debug.coverage": "session",
  "cooperate.sync": "session",
  "hover": "session",
  "navigate": "session",
  "reload": "session",
  "navigate-back": "session",
  "navigate-forward": "session",
  "click": "session",
  "click-backend": "session",
  "fill": "session",
  "press": "session",
  "select": "session",
  "focus": "session",
  "blur": "session",
  "scroll-to": "session",
  "wheel": "session",
  "drag": "session",
  "upload": "session",
  "download": "session",
  "evaluate": "session",
  "webmcp.list": "session",
  "webmcp.call": "session",
  "emulate": "session",
  "network.start": "session",
  "network.stop": "session",
  "debug.start": "session",
  "debug.stop": "session",
  "trace.start": "session",
  "trace.stop": "session",
  "trace.status": "session",
  "pdf": "session",
  "refs.negotiate": "session",
  "longshot.recover": "session",
  "record.start": "session",
  "record.stop": "session",
  "video.start": "session",
  "video.stop": "session",
  "request-help": "session",
  "cooperate.wait": "session",
  "cooperate.handback": "session",
  "cooperate.hold": "session",
  "dialog.arm": "session",
  "dialog.disarm": "session",
  "dialog.accept": "session",
  "dialog.dismiss": "session",
  "tab.list": "instance",
  "tab.new": "instance",
  "tab.policy": "session",
  "tab.alias": "instance",
  "tab.cleanup": "instance",
  "tab.close": "instance",
  "tab.select": "instance",
  "tab.move": "instance",
  "tab.borrow": "session",
  "tab.return": "session",
  "window.list": "instance",
  "window.close": "instance",
  "window.focus": "instance",
  "window.resize": "session",
  "dialog.list": "session",
  "dialog.status": "session",
  "dialog.handle": "session",
  "video.status": "session",
  "video.fetch": "session",
  "video.recover": "session",
  "video.verify": "session",
  "video.discard": "session",
  "record.status": "session",
  "network.replay": "session",
  "network.waterfall": "session",
  "debug.capabilities": "session",
  "debug.pin": "session",
  "debug.pinned": "session",
  "debugger.detach": "instance",
  "debugger.simulate-detach": "instance",
  "screenshot.manual.start": "session",
  "screenshot.manual.frame": "session",
  "screenshot.manual.save": "session",
  "shadow.click": "session",
  "shadow.read": "session",
  "click-point": "session",
  "control-hint": "instance",
  "ui.open": "instance",
  "operation.await": "session",
  "operation.cancel": "session",
  "wait-ms": "session",
  "wait-for-element": "session",
  "wait-for-navigation": "session",
  "actionable": "session",
  "plan": "session",
  "step": "session",
  "debug.rule_add": "session",
  "debug.rule_clear": "session",
  "debug.rule_enable": "session",
  "debug.rule_disable": "session",
  "debug.rule_remove": "session",
  "debug.rule_import": "session",
  "debug.rule_list": "session",
  "debug.rule_export": "session",
  "debug.fetch_probe": "session",
  "window.ensureAgent": "instance",
  "window.newAgent": "instance"
};
export const METHOD_FEATURE_FLOOR = {
  "video.list": "1.9",
  "video.prune": "1.9",
  "debug.history": "1.9",
  "debug.delete": "1.9",
  "read": "1.9",
  "screenshot.read": "1.9",
  "screenshot.release": "1.9",
  "longshot.recover": "1.9",
  "video.start": "1.9",
  "video.stop": "1.9",
  "request-help": "1.9",
  "dialog.arm": "1.9",
  "dialog.disarm": "1.9",
  "dialog.accept": "1.9",
  "dialog.dismiss": "1.9",
  "dialog.list": "1.9",
  "dialog.status": "1.9",
  "dialog.handle": "1.9",
  "video.status": "1.9",
  "video.fetch": "1.9",
  "video.recover": "1.9",
  "video.verify": "1.9",
  "video.discard": "1.9",
  "network.replay": "1.9",
  "debug.pin": "1.9",
  "debug.pinned": "1.9",
  "operation.await": "1.9",
  "operation.cancel": "1.9",
  "plan": "1.9"
};
export const METHOD_FEATURE = {
  "read": "read",
  "plan": "plan",
  "video.start": "video",
  "video.stop": "video",
  "video.status": "video",
  "video.list": "video",
  "video.fetch": "video",
  "video.discard": "video",
  "video.prune": "video",
  "video.recover": "video",
  "video.verify": "video",
  "screenshot.read": "capture.stream",
  "screenshot.release": "capture.stream",
  "longshot.recover": "capture.stream",
  "debug.history": "debug.journal",
  "debug.delete": "debug.journal",
  "debug.pin": "debug.journal",
  "debug.pinned": "debug.journal",
  "network.replay": "har",
  "request-help": "interaction_policy",
  "dialog.arm": "dialog_control",
  "dialog.disarm": "dialog_control",
  "dialog.accept": "dialog_control",
  "dialog.dismiss": "dialog_control",
  "dialog.handle": "dialog_control",
  "dialog.list": "dialog_control",
  "dialog.status": "dialog_control",
  "operation.await": "dialog_control",
  "operation.cancel": "dialog_control"
};
export const FEATURE_MIN_PROTOCOL = {
  "unverified": "1.9",
  "expect": "1.9",
  "read": "1.9",
  "observe-delta": "1.9",
  "plan": "1.9",
  "video": "1.9",
  "capture.stream": "1.9",
  "debug.journal": "1.9",
  "har": "1.9",
  "borrow_confirmation_timeout": "1.9",
  "interaction_policy": "1.9",
  "incognito_sessions": "1.9",
  "dialog_control": "1.9",
  "click_move_click": "1.9",
  "target_control": "1.9"
};
export const FEATURE_NAMES = [
  "unverified",
  "expect",
  "read",
  "observe-delta",
  "plan",
  "video",
  "capture.stream",
  "debug.journal",
  "har",
  "borrow_confirmation_timeout",
  "interaction_policy",
  "incognito_sessions",
  "dialog_control",
  "click_move_click",
  "target_control"
];
export const FEATURE_METHODS = {
  "unverified": [],
  "expect": [],
  "read": [
    "read"
  ],
  "observe-delta": [],
  "plan": [
    "plan"
  ],
  "video": [
    "video.start",
    "video.stop",
    "video.status",
    "video.list",
    "video.fetch",
    "video.discard",
    "video.prune",
    "video.recover",
    "video.verify"
  ],
  "capture.stream": [
    "screenshot.read",
    "screenshot.release",
    "longshot.recover"
  ],
  "debug.journal": [
    "debug.history",
    "debug.delete",
    "debug.pin",
    "debug.pinned"
  ],
  "har": [
    "network.replay"
  ],
  "borrow_confirmation_timeout": [],
  "interaction_policy": [
    "request-help"
  ],
  "incognito_sessions": [],
  "dialog_control": [
    "dialog.arm",
    "dialog.disarm",
    "dialog.accept",
    "dialog.dismiss",
    "dialog.handle",
    "dialog.list",
    "dialog.status",
    "operation.await",
    "operation.cancel"
  ],
  "click_move_click": [],
  "target_control": []
};
export const FEATURE_LABELS = {
  "unverified": "未校验执行",
  "expect": "期望断言",
  "read": "确定性读取",
  "observe-delta": "观察增量",
  "plan": "计划执行",
  "video": "视频录制",
  "capture.stream": "流式截图",
  "debug.journal": "调试日志持久化",
  "har": "HAR 重放",
  "borrow_confirmation_timeout": "借用确认超时",
  "interaction_policy": "人工介入策略",
  "incognito_sessions": "无痕会话",
  "dialog_control": "对话框控制",
  "click_move_click": "点击-移动-点击拖拽",
  "target_control": "目标控制策略"
};
export const PROTOCOL_BASELINE = "1.8";
export const PROTOCOL_CURRENT = "1.9";
export const RECONCILE_STRATEGIES = [
  "none",
  "observe",
  "status",
  "ledger"
];
export const METHOD_STATE = {
  "session.start": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "session.start_tracked": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "session.request_prepare": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.request_claim": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.request_cancel": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.request_status": {
    "owner": "local",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.stop": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "session.stop_all": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.run_log": {
    "owner": "local",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.list": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.rebind": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "session.pause": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "session.resume": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.control_status": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.claim_control": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.release_control": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.handoff": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "session.control_mode": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "browsers": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "status": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "settings.get": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "settings.set": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pair.create": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pair.list": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pair.redeem": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pair.revoke": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pair.renew": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "local.pair": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "local.trust": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "audit.list": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "operations.list": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "operations.get": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "daemon.stop": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "video.list": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "video.prune": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "record.list": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.history": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.delete": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "diagnostics.ui": {
    "owner": "instance",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "transfer.begin": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "transfer.chunk": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "transfer.finish": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "transfer.read": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "transfer.release": {
    "owner": "local",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "observe": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "observe-frames": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "snapshot": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "get-html": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "read": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "view": {
    "owner": "local",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "extract": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "extract.discover": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "extract.table": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "extract.list": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "console": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "network.list": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "network.detail": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "screenshot": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "screenshot.read": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "screenshot.release": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.current": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.request": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.performance": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.coverage": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "cooperate.sync": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "hover": {
    "owner": "session",
    "effect": "transient_input",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "navigate": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "reload": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "navigate-back": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "navigate-forward": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "click": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "click-backend": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "fill": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "press": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "select": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "focus": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "blur": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "scroll-to": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "wheel": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "drag": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "upload": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "download": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "evaluate": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "webmcp.list": {
    "owner": "session",
    "effect": "read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "webmcp.call": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "emulate": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "network.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "network.stop": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "debug.current"
    }
  },
  "debug.stop": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "debug.current"
    }
  },
  "trace.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "trace.status"
    }
  },
  "trace.stop": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "trace.status"
    }
  },
  "trace.status": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "pdf": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "refs.negotiate": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "longshot.recover": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "record.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "record.status"
    }
  },
  "record.stop": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "record.status"
    }
  },
  "video.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "video.status"
    }
  },
  "video.stop": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "video.status"
    }
  },
  "request-help": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "cooperate.wait": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "cooperate.handback": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "cooperate.hold": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "dialog.arm": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "dialog.disarm": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "dialog.accept": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "dialog.status"
    }
  },
  "dialog.dismiss": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "dialog.status"
    }
  },
  "tab.list": {
    "owner": "instance",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "tab.new": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.policy": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "tab.alias": {
    "owner": "instance",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "tab.cleanup": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.close": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.select": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.move": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.borrow": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "tab.return": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "tab.list"
    }
  },
  "window.list": {
    "owner": "instance",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "window.close": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "window.list"
    }
  },
  "window.focus": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "window.list"
    }
  },
  "window.resize": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "window.list"
    }
  },
  "dialog.list": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "dialog.status": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "dialog.handle": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "dialog.status"
    }
  },
  "video.status": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "video.fetch": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "video.status"
    }
  },
  "video.recover": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "video.status"
    }
  },
  "video.verify": {
    "owner": "session",
    "effect": "read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "video.discard": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "video.list"
    }
  },
  "record.status": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "network.replay": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "network.waterfall": {
    "owner": "session",
    "effect": "passive_read",
    "partial": true,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.capabilities": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.pin": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.pinned": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debugger.detach": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debugger.simulate-detach": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "screenshot.manual.start": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "screenshot.manual.frame": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "screenshot.manual.save": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "shadow.click": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "shadow.read": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "click-point": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "control-hint": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "ui.open": {
    "owner": "instance",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "operation.await": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "operation.cancel": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "wait-ms": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "wait-for-element": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "wait-for-navigation": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "actionable": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "plan": {
    "owner": "session",
    "effect": "control_plane",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "ledger",
      "method": null
    }
  },
  "step": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_add": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_clear": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_enable": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_disable": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_remove": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_import": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "debug.rule_list": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.rule_export": {
    "owner": "session",
    "effect": "passive_read",
    "partial": false,
    "unknown": false,
    "reconcile": {
      "strategy": "none",
      "method": null
    }
  },
  "debug.fetch_probe": {
    "owner": "session",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "observe",
      "method": null
    }
  },
  "window.ensureAgent": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "window.list"
    }
  },
  "window.newAgent": {
    "owner": "instance",
    "effect": "browser_mutation",
    "partial": false,
    "unknown": true,
    "reconcile": {
      "strategy": "status",
      "method": "window.list"
    }
  }
};
export const METHOD_PARTIAL = [
  "observe",
  "observe-frames",
  "extract",
  "extract.discover",
  "extract.table",
  "extract.list",
  "console",
  "network.list",
  "screenshot",
  "screenshot.read",
  "longshot.recover",
  "network.waterfall"
];
export const METHOD_UNKNOWN = [
  "session.start",
  "session.start_tracked",
  "session.stop",
  "session.rebind",
  "session.pause",
  "hover",
  "navigate",
  "reload",
  "navigate-back",
  "navigate-forward",
  "click",
  "click-backend",
  "fill",
  "press",
  "select",
  "focus",
  "blur",
  "scroll-to",
  "wheel",
  "drag",
  "upload",
  "download",
  "evaluate",
  "webmcp.call",
  "emulate",
  "network.start",
  "network.stop",
  "debug.start",
  "debug.stop",
  "trace.start",
  "trace.stop",
  "record.start",
  "record.stop",
  "video.start",
  "video.stop",
  "request-help",
  "dialog.arm",
  "dialog.disarm",
  "dialog.accept",
  "dialog.dismiss",
  "tab.new",
  "tab.cleanup",
  "tab.close",
  "tab.select",
  "tab.move",
  "tab.borrow",
  "tab.return",
  "window.close",
  "window.focus",
  "window.resize",
  "dialog.handle",
  "video.fetch",
  "video.recover",
  "video.discard",
  "network.replay",
  "debug.pin",
  "debugger.detach",
  "debugger.simulate-detach",
  "screenshot.manual.start",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "shadow.click",
  "click-point",
  "control-hint",
  "plan",
  "step",
  "debug.rule_add",
  "debug.rule_clear",
  "debug.rule_enable",
  "debug.rule_disable",
  "debug.rule_remove",
  "debug.rule_import",
  "debug.fetch_probe",
  "window.ensureAgent",
  "window.newAgent"
];
export const METHOD_RECONCILE = {
  "session.start": "ledger",
  "session.start_tracked": "ledger",
  "session.request_prepare": "none",
  "session.request_claim": "none",
  "session.request_cancel": "none",
  "session.request_status": "none",
  "session.stop": "ledger",
  "session.stop_all": "none",
  "session.run_log": "none",
  "session.list": "none",
  "session.rebind": "ledger",
  "session.pause": "ledger",
  "session.resume": "none",
  "session.control_status": "none",
  "session.claim_control": "none",
  "session.release_control": "none",
  "session.handoff": "none",
  "session.control_mode": "none",
  "browsers": "none",
  "status": "none",
  "settings.get": "none",
  "settings.set": "none",
  "pair.create": "none",
  "pair.list": "none",
  "pair.redeem": "none",
  "pair.revoke": "none",
  "pair.renew": "none",
  "local.pair": "none",
  "local.trust": "none",
  "audit.list": "none",
  "operations.list": "none",
  "operations.get": "none",
  "daemon.stop": "none",
  "video.list": "none",
  "video.prune": "none",
  "record.list": "none",
  "debug.history": "none",
  "debug.delete": "none",
  "diagnostics.ui": "none",
  "transfer.begin": "none",
  "transfer.chunk": "none",
  "transfer.finish": "none",
  "transfer.read": "none",
  "transfer.release": "none",
  "observe": "none",
  "observe-frames": "none",
  "snapshot": "none",
  "get-html": "none",
  "read": "none",
  "view": "none",
  "extract": "none",
  "extract.discover": "none",
  "extract.table": "none",
  "extract.list": "none",
  "console": "none",
  "network.list": "none",
  "network.detail": "none",
  "screenshot": "none",
  "screenshot.read": "none",
  "screenshot.release": "none",
  "debug.current": "none",
  "debug.request": "none",
  "debug.performance": "none",
  "debug.coverage": "none",
  "cooperate.sync": "none",
  "hover": "observe",
  "navigate": "observe",
  "reload": "observe",
  "navigate-back": "observe",
  "navigate-forward": "observe",
  "click": "observe",
  "click-backend": "observe",
  "fill": "observe",
  "press": "observe",
  "select": "observe",
  "focus": "observe",
  "blur": "observe",
  "scroll-to": "observe",
  "wheel": "observe",
  "drag": "observe",
  "upload": "observe",
  "download": "observe",
  "evaluate": "observe",
  "webmcp.list": "none",
  "webmcp.call": "observe",
  "emulate": "observe",
  "network.start": "observe",
  "network.stop": "observe",
  "debug.start": "status:debug.current",
  "debug.stop": "status:debug.current",
  "trace.start": "status:trace.status",
  "trace.stop": "status:trace.status",
  "trace.status": "none",
  "pdf": "none",
  "refs.negotiate": "none",
  "longshot.recover": "none",
  "record.start": "status:record.status",
  "record.stop": "status:record.status",
  "video.start": "status:video.status",
  "video.stop": "status:video.status",
  "request-help": "observe",
  "cooperate.wait": "none",
  "cooperate.handback": "none",
  "cooperate.hold": "none",
  "dialog.arm": "observe",
  "dialog.disarm": "observe",
  "dialog.accept": "status:dialog.status",
  "dialog.dismiss": "status:dialog.status",
  "tab.list": "none",
  "tab.new": "status:tab.list",
  "tab.policy": "none",
  "tab.alias": "none",
  "tab.cleanup": "status:tab.list",
  "tab.close": "status:tab.list",
  "tab.select": "status:tab.list",
  "tab.move": "status:tab.list",
  "tab.borrow": "status:tab.list",
  "tab.return": "status:tab.list",
  "window.list": "none",
  "window.close": "status:window.list",
  "window.focus": "status:window.list",
  "window.resize": "status:window.list",
  "dialog.list": "none",
  "dialog.status": "none",
  "dialog.handle": "status:dialog.status",
  "video.status": "none",
  "video.fetch": "status:video.status",
  "video.recover": "status:video.status",
  "video.verify": "none",
  "video.discard": "status:video.list",
  "record.status": "none",
  "network.replay": "observe",
  "network.waterfall": "none",
  "debug.capabilities": "none",
  "debug.pin": "observe",
  "debug.pinned": "none",
  "debugger.detach": "observe",
  "debugger.simulate-detach": "observe",
  "screenshot.manual.start": "observe",
  "screenshot.manual.frame": "observe",
  "screenshot.manual.save": "observe",
  "shadow.click": "observe",
  "shadow.read": "none",
  "click-point": "observe",
  "control-hint": "observe",
  "ui.open": "none",
  "operation.await": "none",
  "operation.cancel": "none",
  "wait-ms": "none",
  "wait-for-element": "none",
  "wait-for-navigation": "none",
  "actionable": "none",
  "plan": "ledger",
  "step": "observe",
  "debug.rule_add": "observe",
  "debug.rule_clear": "observe",
  "debug.rule_enable": "observe",
  "debug.rule_disable": "observe",
  "debug.rule_remove": "observe",
  "debug.rule_import": "observe",
  "debug.rule_list": "none",
  "debug.rule_export": "none",
  "debug.fetch_probe": "observe",
  "window.ensureAgent": "status:window.list",
  "window.newAgent": "status:window.list"
};
export const DAEMON_ONLY_METHODS = [
  "command.cancel",
  "inflight.list",
  "ledger.resolve",
  "ledger.status",
  "pair.rotate",
  "cancel",
  "ledger.request"
];
export const METHOD_SCHEMA_KEYS = {
  "observe": {
    "required": [],
    "properties": [
      "ax",
      "baseline",
      "closedShadow",
      "compareAx",
      "cursor",
      "debugSurfaces",
      "deepMaxTokens",
      "delta",
      "facts",
      "fallbackAx",
      "force",
      "maxDepth",
      "maxTokens",
      "pipeline",
      "probeHover",
      "session",
      "sessionId",
      "tabId",
      "vom",
      "vomBillingModel",
      "vomDeep",
      "vomExcludeHidden",
      "vomExplain",
      "vomGroupContext",
      "vomGroupTokens",
      "vomMaxNodes",
      "vomMaxTokens",
      "vomMinScore",
      "vomPerGroup",
      "vomProfile",
      "vomRank",
      "vomSemanticMaxGroups",
      "vomSemanticMaxTokens",
      "vomSemanticMinScore",
      "vomTop",
      "vomTree",
      "vomWeights"
    ]
  },
  "console": {
    "required": [],
    "properties": [
      "includeStack",
      "limit",
      "maxTextChars",
      "session",
      "sessionId",
      "since",
      "tabId"
    ]
  },
  "navigate": {
    "required": [
      "url"
    ],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "url"
    ]
  },
  "wait-ms": {
    "required": [
      "ms"
    ],
    "properties": [
      "commandId",
      "ms",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "wait-for-element": {
    "required": [],
    "properties": [
      "operationId",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "state",
      "tabId",
      "timeoutMs"
    ]
  },
  "wait-for-navigation": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs",
      "waitUntil"
    ]
  },
  "click": {
    "required": [],
    "properties": [
      "button",
      "clickCount",
      "force",
      "ref",
      "selector",
      "stableRef",
      "text",
      "trusted",
      "waitTimeoutMs"
    ]
  },
  "click-backend": {
    "required": [],
    "properties": [
      "backendId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "hover": {
    "required": [],
    "properties": [
      "force",
      "ref",
      "selector",
      "stableRef",
      "trusted",
      "waitTimeoutMs"
    ]
  },
  "fill": {
    "required": [
      "value"
    ],
    "properties": [
      "force",
      "noClear",
      "ref",
      "selector",
      "stableRef",
      "trusted",
      "value",
      "waitTimeoutMs"
    ]
  },
  "press": {
    "required": [
      "key"
    ],
    "properties": [
      "force",
      "key",
      "ref",
      "selector",
      "stableRef",
      "trusted",
      "waitTimeoutMs"
    ]
  },
  "select": {
    "required": [
      "value"
    ],
    "properties": [
      "ref",
      "selector",
      "stableRef",
      "value",
      "waitTimeoutMs"
    ]
  },
  "read": {
    "required": [],
    "properties": [
      "all",
      "fields",
      "fieldsJson",
      "maxBytes",
      "maxNodes",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId",
      "timeoutMs"
    ]
  },
  "evaluate": {
    "required": [
      "expression"
    ],
    "properties": [
      "awaitPromise",
      "expression",
      "returnByValue",
      "session",
      "sessionId",
      "tabId",
      "unverified"
    ]
  },
  "wheel": {
    "required": [],
    "properties": [
      "deltaX",
      "deltaY",
      "modifiers",
      "ref",
      "selector",
      "timeoutMs"
    ]
  },
  "webmcp.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "webmcp.call": {
    "required": [
      "name"
    ],
    "properties": [
      "input",
      "name",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "drag": {
    "required": [],
    "properties": [
      "button",
      "capture",
      "delta",
      "durationMs",
      "holdMs",
      "imageDx",
      "imageDy",
      "imageX",
      "imageY",
      "mode",
      "modifiers",
      "observationId",
      "source",
      "steps",
      "target",
      "timeoutMs",
      "waitTimeoutMs"
    ]
  },
  "transfer.begin": {
    "required": [
      "byteSize",
      "name"
    ],
    "properties": [
      "byteSize",
      "name",
      "session",
      "sessionId"
    ]
  },
  "transfer.chunk": {
    "required": [
      "dataBase64",
      "offset",
      "transferId"
    ],
    "properties": [
      "dataBase64",
      "offset",
      "transferId"
    ]
  },
  "transfer.finish": {
    "required": [
      "transferId"
    ],
    "properties": [
      "transferId"
    ]
  },
  "transfer.read": {
    "required": [
      "offset",
      "transferId"
    ],
    "properties": [
      "maxBytes",
      "offset",
      "transferId"
    ]
  },
  "transfer.release": {
    "required": [
      "transferId"
    ],
    "properties": [
      "transferId"
    ]
  },
  "session.control_status": {
    "required": [],
    "properties": [
      "session",
      "sessionId"
    ]
  },
  "session.claim_control": {
    "required": [],
    "properties": [
      "expectEpoch",
      "leaseMs",
      "session",
      "sessionId"
    ]
  },
  "session.release_control": {
    "required": [],
    "properties": [
      "expectEpoch",
      "session",
      "sessionId"
    ]
  },
  "session.handoff": {
    "required": [
      "to"
    ],
    "properties": [
      "expectEpoch",
      "leaseMs",
      "session",
      "sessionId",
      "to"
    ]
  },
  "session.control_mode": {
    "required": [
      "mode"
    ],
    "properties": [
      "mode",
      "session",
      "sessionId"
    ]
  },
  "plan": {
    "required": [
      "steps"
    ],
    "properties": [
      "session",
      "sessionId",
      "steps",
      "tabId"
    ]
  },
  "extract": {
    "required": [],
    "properties": [
      "action",
      "cursor",
      "fields",
      "itemSelector",
      "maxBytes",
      "maxCells",
      "maxColumns",
      "maxRows",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId",
      "targetId",
      "timeoutMs"
    ]
  },
  "extract.discover": {
    "required": [],
    "properties": [
      "maxTargets",
      "previewColumns",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "extract.table": {
    "required": [],
    "properties": [
      "cursor",
      "frameId",
      "maxBytes",
      "maxCells",
      "maxColumns",
      "maxRows",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId",
      "target"
    ]
  },
  "extract.list": {
    "required": [],
    "properties": [
      "cursor",
      "frameId",
      "itemSelector",
      "maxBytes",
      "maxCells",
      "maxColumns",
      "maxRows",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "longshot.recover": {
    "required": [],
    "properties": [
      "captureId",
      "longshotId",
      "scope",
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "refs.negotiate": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "stableRef",
      "stableRefs",
      "tabId"
    ]
  },
  "upload": {
    "required": [],
    "properties": [
      "expectRevision",
      "files",
      "mode",
      "paths",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId",
      "timeoutMs"
    ]
  },
  "pdf": {
    "required": [],
    "properties": [
      "landscape",
      "margins",
      "pages",
      "paperHeight",
      "paperWidth",
      "preferCssPageSize",
      "printBackground",
      "scale",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "screenshot": {
    "required": [],
    "properties": [
      "annotate",
      "format",
      "fullPage",
      "grid",
      "gridStep",
      "profile",
      "ref",
      "region",
      "scale",
      "scope",
      "segmented",
      "selector",
      "session",
      "sessionId",
      "staleAttempts",
      "stream",
      "tabId",
      "tileSize",
      "visualIndex"
    ]
  },
  "screenshot.read": {
    "required": [
      "captureId"
    ],
    "properties": [
      "captureId",
      "length",
      "offset",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "screenshot.release": {
    "required": [
      "captureId"
    ],
    "properties": [
      "captureId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "record.start": {
    "required": [],
    "properties": [
      "includeAgent",
      "maxPageTokens",
      "purpose",
      "redactValues",
      "screenshots",
      "session",
      "sessionId",
      "supportsTabSwitchSteps",
      "tabId",
      "traceVersion",
      "url"
    ]
  },
  "record.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "record.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "trace.start": {
    "required": [],
    "properties": [
      "categories",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "trace.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "trace.status": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.start": {
    "required": [],
    "properties": [
      "durationMs",
      "encoder",
      "forceFrames",
      "maxConcurrent",
      "maxDurationMs",
      "maxSegmentBytes",
      "maxTotalBytes",
      "quality",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.stop": {
    "required": [],
    "properties": [
      "recording",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.rule_add": {
    "required": [],
    "properties": [
      "rule",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "reload": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "navigate-back": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "navigate-forward": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "snapshot": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "observe-frames": {
    "required": [],
    "properties": [
      "cursor",
      "maxDepth",
      "maxTokens",
      "session",
      "sessionId",
      "tabId",
      "vom"
    ]
  },
  "actionable": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "blur": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "focus": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "get-html": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "scroll-to": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "shadow.read": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId"
    ]
  },
  "shadow.click": {
    "required": [],
    "properties": [
      "expectRevision",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId",
      "text"
    ]
  },
  "download": {
    "required": [],
    "properties": [
      "expectRevision",
      "out",
      "ref",
      "selector",
      "session",
      "sessionId",
      "stableRef",
      "tabId",
      "url"
    ]
  },
  "click-point": {
    "required": [],
    "properties": [
      "capture",
      "imageX",
      "imageY",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "screenshot.manual.start": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "screenshot.manual.frame": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "screenshot.manual.save": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.list": {
    "required": [],
    "properties": [
      "scope",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.new": {
    "required": [],
    "properties": [
      "allowedOrigins",
      "focus",
      "incognito",
      "newWindow",
      "noFocus",
      "readOnly",
      "session",
      "sessionId",
      "tabId",
      "url",
      "windowId"
    ]
  },
  "tab.policy": {
    "required": [],
    "properties": [
      "allowedOrigins",
      "clear",
      "readOnly",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.alias": {
    "required": [],
    "properties": [
      "action",
      "alias",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.cleanup": {
    "required": [],
    "properties": [
      "dryRun",
      "idleMs",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.close": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "tab.select": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "tab.borrow": {
    "required": [],
    "properties": [
      "confirmationTimeoutMs",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.return": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "tab.move": {
    "required": [],
    "properties": [
      "index",
      "session",
      "sessionId",
      "tabId",
      "windowId"
    ]
  },
  "window.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "window.close": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "windowId"
    ]
  },
  "window.focus": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "windowId"
    ]
  },
  "window.resize": {
    "required": [],
    "properties": [
      "height",
      "session",
      "sessionId",
      "tabId",
      "width"
    ]
  },
  "window.ensureAgent": {
    "required": [],
    "properties": [
      "focus",
      "incognito",
      "noFocus",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "window.newAgent": {
    "required": [],
    "properties": [
      "focus",
      "incognito",
      "noFocus",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.status": {
    "required": [],
    "properties": [
      "clear",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.arm": {
    "required": [],
    "properties": [
      "alert",
      "beforeUnload",
      "confirm",
      "prompt",
      "promptText",
      "queue",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.disarm": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.accept": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "text"
    ]
  },
  "dialog.dismiss": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "dialog.handle": {
    "required": [],
    "properties": [
      "accept",
      "dismiss",
      "promptText",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.start": {
    "required": [],
    "properties": [
      "bodies",
      "session",
      "sessionId",
      "tabId",
      "wsPayloadLimit"
    ]
  },
  "network.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.list": {
    "required": [],
    "properties": [
      "filter",
      "limit",
      "session",
      "sessionId",
      "since",
      "tabId"
    ]
  },
  "network.detail": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.waterfall": {
    "required": [],
    "properties": [
      "limit",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.replay": {
    "required": [],
    "properties": [
      "id",
      "overrides",
      "request",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.start": {
    "required": [],
    "properties": [
      "action",
      "bodies",
      "budget",
      "commandId",
      "fields",
      "id",
      "includeControlled",
      "kind",
      "limit",
      "maxChars",
      "method",
      "name",
      "offset",
      "part",
      "pointer",
      "replay",
      "resourceType",
      "rule",
      "runId",
      "session",
      "sessionId",
      "since",
      "slowMs",
      "state",
      "status",
      "tabId",
      "url",
      "waitMs",
      "windowMs"
    ]
  },
  "debug.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "trace",
      "traceOrigin"
    ]
  },
  "debug.current": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "trace"
    ]
  },
  "debug.request": {
    "required": [],
    "properties": [
      "action",
      "budget",
      "commandId",
      "fields",
      "id",
      "includeControlled",
      "kind",
      "limit",
      "maxChars",
      "method",
      "name",
      "offset",
      "part",
      "pointer",
      "replay",
      "resourceType",
      "rule",
      "runId",
      "session",
      "sessionId",
      "since",
      "slowMs",
      "state",
      "status",
      "tabId",
      "url",
      "waitMs",
      "windowMs"
    ]
  },
  "debug.performance": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.coverage": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.history": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.delete": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.fetch_probe": {
    "required": [],
    "properties": [
      "ms",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.pin": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.pinned": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.capabilities": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_add": {
    "required": [],
    "properties": [
      "rule",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_clear": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_enable": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_disable": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_remove": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_export": {
    "required": [],
    "properties": [
      "output",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.rule_import": {
    "required": [],
    "properties": [
      "rules",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.status": {
    "required": [],
    "properties": [
      "recording",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.fetch": {
    "required": [],
    "properties": [
      "recording",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.discard": {
    "required": [],
    "properties": [
      "recording",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.prune": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "ttlMs"
    ]
  },
  "video.recover": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "video.verify": {
    "required": [],
    "properties": [
      "recording",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "record.status": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "cooperate.sync": {
    "required": [],
    "properties": [
      "contextLines",
      "matchText",
      "policy",
      "probeHover",
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "cooperate.hold": {
    "required": [],
    "properties": [
      "held",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "cooperate.wait": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "cooperate.handback": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "operation.await": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "operation.cancel": {
    "required": [],
    "properties": [
      "id",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "request-help": {
    "required": [],
    "properties": [
      "reason",
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "emulate": {
    "required": [],
    "properties": [
      "acceptLanguage",
      "device",
      "dpr",
      "geolocation",
      "height",
      "locale",
      "mobile",
      "platform",
      "reset",
      "session",
      "sessionId",
      "tabId",
      "timezone",
      "touch",
      "ua",
      "userAgent",
      "viewport",
      "width"
    ]
  },
  "step": {
    "required": [],
    "properties": [
      "action",
      "saveFull",
      "session",
      "sessionId",
      "tabId",
      "untilVisible",
      "waitTimeoutMs"
    ]
  },
  "ui.open": {
    "required": [],
    "properties": [
      "page",
      "query",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "diagnostics.ui": {
    "required": [],
    "properties": [
      "page",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "control-hint": {
    "required": [],
    "properties": [
      "enabled",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debugger.detach": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debugger.simulate-detach": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "browsers": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "pair.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.list": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "status": {
    "required": [],
    "properties": [
      "doctor",
      "limit",
      "limitSessions",
      "session",
      "sessionId",
      "strategy",
      "tabId",
      "view",
      "views"
    ]
  },
  "audit.list": {
    "required": [],
    "properties": [
      "limit",
      "session",
      "sessionId",
      "since",
      "tabId"
    ]
  },
  "pair.renew": {
    "required": [],
    "properties": [
      "deviceId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "pair.revoke": {
    "required": [],
    "properties": [
      "code",
      "deviceId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "local.pair": {
    "required": [],
    "properties": [
      "replace",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "local.trust": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "strict",
      "tabId"
    ]
  },
  "session.start": {
    "required": [],
    "properties": [
      "allowDomains",
      "browser",
      "controlMode",
      "controller",
      "denyDomains",
      "focus",
      "incognito",
      "minIntervalMs",
      "noFocus",
      "requestId",
      "scope",
      "session",
      "sessionId",
      "share",
      "tab",
      "tabId"
    ]
  },
  "session.start_tracked": {
    "required": [],
    "properties": [
      "allowDomains",
      "browser",
      "controlMode",
      "controller",
      "denyDomains",
      "focus",
      "incognito",
      "minIntervalMs",
      "noFocus",
      "requestId",
      "scope",
      "session",
      "sessionId",
      "share",
      "tab",
      "tabId"
    ]
  },
  "session.request_prepare": {
    "required": [],
    "properties": [
      "browser",
      "focus",
      "incognito",
      "noFocus",
      "requestId",
      "session",
      "sessionId",
      "tab",
      "tabId"
    ]
  },
  "session.request_claim": {
    "required": [],
    "properties": [
      "requestId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.request_cancel": {
    "required": [],
    "properties": [
      "requestId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.request_status": {
    "required": [],
    "properties": [
      "requestId",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.stop": {
    "required": [],
    "properties": [
      "keep",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.stop_all": {
    "required": [],
    "properties": [
      "keep",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "session.run_log": {
    "required": [],
    "properties": [
      "limit",
      "session",
      "sessionId",
      "tabId"
    ]
  }
};
export const PARAM_ALIASES = {
  "observe": {
    "closed_shadow": "closedShadow",
    "compare_ax": "compareAx",
    "debug_surfaces": "debugSurfaces",
    "deep_max_tokens": "deepMaxTokens",
    "fallback_ax": "fallbackAx",
    "max_depth": "maxDepth",
    "max_tokens": "maxTokens",
    "probe_hover": "probeHover",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "vom_billing_model": "vomBillingModel",
    "vom_deep": "vomDeep",
    "vom_exclude_hidden": "vomExcludeHidden",
    "vom_explain": "vomExplain",
    "vom_group_context": "vomGroupContext",
    "vom_group_tokens": "vomGroupTokens",
    "vom_max_nodes": "vomMaxNodes",
    "vom_max_tokens": "vomMaxTokens",
    "vom_min_score": "vomMinScore",
    "vom_per_group": "vomPerGroup",
    "vom_profile": "vomProfile",
    "vom_rank": "vomRank",
    "vom_semantic_max_groups": "vomSemanticMaxGroups",
    "vom_semantic_max_tokens": "vomSemanticMaxTokens",
    "vom_semantic_min_score": "vomSemanticMinScore",
    "vom_top": "vomTop",
    "vom_tree": "vomTree",
    "vom_weights": "vomWeights"
  },
  "console": {
    "include_stack": "includeStack",
    "max_text_chars": "maxTextChars",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "navigate": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wait-ms": {
    "command_id": "commandId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wait-for-element": {
    "operation_id": "operationId",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "wait-for-navigation": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs",
    "wait_until": "waitUntil"
  },
  "click": {
    "click_count": "clickCount",
    "stable_ref": "stableRef",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "click-backend": {
    "backend_id": "backendId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "hover": {
    "stable_ref": "stableRef",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "fill": {
    "no_clear": "noClear",
    "stable_ref": "stableRef",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "press": {
    "stable_ref": "stableRef",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "select": {
    "stable_ref": "stableRef",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "read": {
    "fields_json": "fieldsJson",
    "max_bytes": "maxBytes",
    "max_nodes": "maxNodes",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "evaluate": {
    "await_promise": "awaitPromise",
    "return_by_value": "returnByValue",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wheel": {
    "delta_x": "deltaX",
    "delta_y": "deltaY",
    "timeout_ms": "timeoutMs"
  },
  "webmcp.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "webmcp.call": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "drag": {
    "duration_ms": "durationMs",
    "hold_ms": "holdMs",
    "image_dx": "imageDx",
    "image_dy": "imageDy",
    "image_x": "imageX",
    "image_y": "imageY",
    "observation_id": "observationId",
    "timeout_ms": "timeoutMs",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "transfer.begin": {
    "byte_size": "byteSize",
    "session_id": "sessionId"
  },
  "transfer.chunk": {
    "data_base64": "dataBase64",
    "transfer_id": "transferId"
  },
  "transfer.finish": {
    "transfer_id": "transferId"
  },
  "transfer.read": {
    "max_bytes": "maxBytes",
    "transfer_id": "transferId"
  },
  "transfer.release": {
    "transfer_id": "transferId"
  },
  "session.control_status": {
    "session_id": "sessionId"
  },
  "session.claim_control": {
    "expect_epoch": "expectEpoch",
    "lease_ms": "leaseMs",
    "session_id": "sessionId"
  },
  "session.release_control": {
    "expect_epoch": "expectEpoch",
    "session_id": "sessionId"
  },
  "session.handoff": {
    "expect_epoch": "expectEpoch",
    "lease_ms": "leaseMs",
    "session_id": "sessionId"
  },
  "session.control_mode": {
    "session_id": "sessionId"
  },
  "plan": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract": {
    "item_selector": "itemSelector",
    "max_bytes": "maxBytes",
    "max_cells": "maxCells",
    "max_columns": "maxColumns",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "target_id": "targetId",
    "timeout_ms": "timeoutMs"
  },
  "extract.discover": {
    "max_targets": "maxTargets",
    "preview_columns": "previewColumns",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract.table": {
    "frame_id": "frameId",
    "max_bytes": "maxBytes",
    "max_cells": "maxCells",
    "max_columns": "maxColumns",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract.list": {
    "frame_id": "frameId",
    "item_selector": "itemSelector",
    "max_bytes": "maxBytes",
    "max_cells": "maxCells",
    "max_columns": "maxColumns",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "longshot.recover": {
    "capture_id": "captureId",
    "longshot_id": "longshotId",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "refs.negotiate": {
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "stable_refs": "stableRefs",
    "tab_id": "tabId"
  },
  "upload": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "pdf": {
    "paper_height": "paperHeight",
    "paper_width": "paperWidth",
    "prefer_css_page_size": "preferCssPageSize",
    "print_background": "printBackground",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot": {
    "full_page": "fullPage",
    "grid_step": "gridStep",
    "session_id": "sessionId",
    "stale_attempts": "staleAttempts",
    "tab_id": "tabId",
    "tile_size": "tileSize",
    "visual_index": "visualIndex"
  },
  "screenshot.read": {
    "capture_id": "captureId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot.release": {
    "capture_id": "captureId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "record.start": {
    "include_agent": "includeAgent",
    "max_page_tokens": "maxPageTokens",
    "redact_values": "redactValues",
    "session_id": "sessionId",
    "supports_tab_switch_steps": "supportsTabSwitchSteps",
    "tab_id": "tabId",
    "trace_version": "traceVersion"
  },
  "record.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "record.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "trace.start": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "trace.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "trace.status": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.start": {
    "duration_ms": "durationMs",
    "force_frames": "forceFrames",
    "max_concurrent": "maxConcurrent",
    "max_duration_ms": "maxDurationMs",
    "max_segment_bytes": "maxSegmentBytes",
    "max_total_bytes": "maxTotalBytes",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.rule_add": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "reload": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "navigate-back": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "navigate-forward": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "snapshot": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "observe-frames": {
    "max_depth": "maxDepth",
    "max_tokens": "maxTokens",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "actionable": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "blur": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "focus": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "get-html": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "scroll-to": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "shadow.read": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "shadow.click": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "download": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "stable_ref": "stableRef",
    "tab_id": "tabId"
  },
  "click-point": {
    "image_x": "imageX",
    "image_y": "imageY",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot.manual.start": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot.manual.frame": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot.manual.save": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.new": {
    "allowed_origins": "allowedOrigins",
    "new_window": "newWindow",
    "no_focus": "noFocus",
    "read_only": "readOnly",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "window_id": "windowId"
  },
  "tab.policy": {
    "allowed_origins": "allowedOrigins",
    "read_only": "readOnly",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.alias": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.cleanup": {
    "dry_run": "dryRun",
    "idle_ms": "idleMs",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.close": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "tab.select": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "tab.borrow": {
    "confirmation_timeout_ms": "confirmationTimeoutMs",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.return": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "tab.move": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "window_id": "windowId"
  },
  "window.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "window.close": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "window_id": "windowId"
  },
  "window.focus": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "window_id": "windowId"
  },
  "window.resize": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "window.ensureAgent": {
    "no_focus": "noFocus",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "window.newAgent": {
    "no_focus": "noFocus",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.status": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.arm": {
    "before_unload": "beforeUnload",
    "prompt_text": "promptText",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.disarm": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.accept": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.dismiss": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "dialog.handle": {
    "prompt_text": "promptText",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.start": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "ws_payload_limit": "wsPayloadLimit"
  },
  "network.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.detail": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.waterfall": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "network.replay": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.start": {
    "command_id": "commandId",
    "include_controlled": "includeControlled",
    "max_chars": "maxChars",
    "resource_type": "resourceType",
    "run_id": "runId",
    "session_id": "sessionId",
    "slow_ms": "slowMs",
    "tab_id": "tabId",
    "wait_ms": "waitMs",
    "window_ms": "windowMs"
  },
  "debug.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "trace_origin": "traceOrigin"
  },
  "debug.current": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.request": {
    "command_id": "commandId",
    "include_controlled": "includeControlled",
    "max_chars": "maxChars",
    "resource_type": "resourceType",
    "run_id": "runId",
    "session_id": "sessionId",
    "slow_ms": "slowMs",
    "tab_id": "tabId",
    "wait_ms": "waitMs",
    "window_ms": "windowMs"
  },
  "debug.performance": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.coverage": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.history": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.delete": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.fetch_probe": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.pin": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.pinned": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.capabilities": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_add": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_clear": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_enable": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_disable": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_remove": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_export": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.rule_import": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.status": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.fetch": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.discard": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.prune": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "ttl_ms": "ttlMs"
  },
  "video.recover": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.verify": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "record.status": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "cooperate.sync": {
    "context_lines": "contextLines",
    "match_text": "matchText",
    "probe_hover": "probeHover",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "cooperate.hold": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "cooperate.wait": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "cooperate.handback": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "operation.await": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "operation.cancel": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "request-help": {
    "session_id": "sessionId",
    "tab_id": "tabId",
    "timeout_ms": "timeoutMs"
  },
  "emulate": {
    "accept_language": "acceptLanguage",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "user_agent": "userAgent"
  },
  "step": {
    "save_full": "saveFull",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "until_visible": "untilVisible",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "ui.open": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "diagnostics.ui": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "control-hint": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debugger.detach": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debugger.simulate-detach": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "browsers": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "pair.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "status": {
    "limit_sessions": "limitSessions",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "audit.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "pair.renew": {
    "device_id": "deviceId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "pair.revoke": {
    "device_id": "deviceId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "local.pair": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "local.trust": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.start": {
    "allow_domains": "allowDomains",
    "control_mode": "controlMode",
    "deny_domains": "denyDomains",
    "min_interval_ms": "minIntervalMs",
    "no_focus": "noFocus",
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.start_tracked": {
    "allow_domains": "allowDomains",
    "control_mode": "controlMode",
    "deny_domains": "denyDomains",
    "min_interval_ms": "minIntervalMs",
    "no_focus": "noFocus",
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.request_prepare": {
    "no_focus": "noFocus",
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.request_claim": {
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.request_cancel": {
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.request_status": {
    "request_id": "requestId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.stop_all": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "session.run_log": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  }
};

export function methodEffect(method) { return METHOD_EFFECT[method] || null; }
export function isKnownMethod(method) { return Object.prototype.hasOwnProperty.call(METHOD_EFFECT, method); }

/** 方法五维状态（owner/effect/partial/unknown/reconcile）；未知方法返回 null。 */
export function methodState(method) { return METHOD_STATE[method] || null; }

/** 方法要求的协议版本（无方法级特性门返回 null）。 */
export function methodFloor(method) { return METHOD_FEATURE_FLOOR[method] || null; }

/** 把 snake_case 别名归一化为协议 camelCase；未知方法/未知键原样返回。 */
export function normalizeParams(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const map = PARAM_ALIASES[method];
  if (!map) return params;
  let changed = false;
  const out = { ...params };
  for (const [snake, camel] of Object.entries(map)) {
    if (out[camel] === undefined && out[snake] !== undefined) {
      out[camel] = out[snake];
      delete out[snake];
      changed = true;
    }
  }
  return changed ? out : params;
}
