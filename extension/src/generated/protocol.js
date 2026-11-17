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
  "session.list": "control_plane",
  "session.rebind": "control_plane",
  "session.pause": "control_plane",
  "session.resume": "control_plane",
  "browsers": "control_plane",
  "status": "control_plane",
  "settings.get": "control_plane",
  "settings.set": "control_plane",
  "pair.create": "control_plane",
  "pair.list": "control_plane",
  "pair.redeem": "control_plane",
  "pair.revoke": "control_plane",
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
  "debug.current": "passive_read",
  "debug.request": "passive_read",
  "debug.performance": "passive_read",
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
  "emulate": "browser_mutation",
  "network.start": "browser_mutation",
  "network.stop": "browser_mutation",
  "debug.start": "browser_mutation",
  "debug.stop": "browser_mutation",
  "record.start": "browser_mutation",
  "record.stop": "browser_mutation",
  "video.start": "browser_mutation",
  "video.stop": "browser_mutation",
  "request-help": "browser_mutation",
  "cooperate.wait": "browser_mutation",
  "cooperate.handback": "browser_mutation",
  "dialog.arm": "browser_mutation",
  "dialog.disarm": "browser_mutation",
  "dialog.accept": "browser_mutation",
  "dialog.dismiss": "browser_mutation",
  "tab.list": "control_plane",
  "tab.new": "browser_mutation",
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
  "video.discard": "browser_mutation",
  "record.status": "control_plane",
  "network.replay": "browser_mutation",
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
  "cooperate.sync",
  "cooperate.wait",
  "daemon.stop",
  "debug.capabilities",
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
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "operations.get",
  "operations.list",
  "pair.create",
  "pair.list",
  "pair.redeem",
  "pair.revoke",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "scroll-to",
  "select",
  "session.list",
  "session.pause",
  "session.rebind",
  "session.request_cancel",
  "session.request_claim",
  "session.request_prepare",
  "session.request_status",
  "session.resume",
  "session.start",
  "session.start_tracked",
  "session.stop",
  "settings.get",
  "settings.set",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "status",
  "step",
  "tab.borrow",
  "tab.close",
  "tab.list",
  "tab.move",
  "tab.new",
  "tab.return",
  "tab.select",
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
  "view",
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
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
  "cooperate.handback",
  "cooperate.wait",
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
  "tab.close",
  "tab.move",
  "tab.new",
  "tab.return",
  "tab.select",
  "upload",
  "video.discard",
  "video.fetch",
  "video.recover",
  "video.start",
  "video.stop",
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
  "command.cancel",
  "daemon.stop",
  "inflight.list",
  "ledger.resolve",
  "ledger.status",
  "local.pair",
  "local.trust",
  "operations.get",
  "operations.list",
  "pair.create",
  "pair.list",
  "pair.redeem",
  "pair.revoke",
  "pair.rotate",
  "session.list",
  "session.pause",
  "session.rebind",
  "session.request_cancel",
  "session.request_claim",
  "session.request_prepare",
  "session.request_status",
  "session.resume",
  "session.start",
  "session.start_tracked",
  "session.stop",
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
  "cooperate.sync",
  "cooperate.wait",
  "debug.capabilities",
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
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "scroll-to",
  "select",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "step",
  "tab.borrow",
  "tab.return",
  "upload",
  "video.discard",
  "video.fetch",
  "video.list",
  "video.prune",
  "video.recover",
  "video.start",
  "video.status",
  "video.stop",
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
  "wheel",
  "window.resize"
]);
export const INSTANCE_METHODS = new Set([
  "control-hint",
  "debugger.detach",
  "debugger.simulate-detach",
  "diagnostics.ui",
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
  "cooperate.sync",
  "cooperate.wait",
  "debug.capabilities",
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
  "navigate",
  "navigate-back",
  "navigate-forward",
  "network.detail",
  "network.list",
  "network.replay",
  "network.start",
  "network.stop",
  "observe",
  "observe-frames",
  "operation.await",
  "operation.cancel",
  "plan",
  "press",
  "read",
  "record.list",
  "record.start",
  "record.status",
  "record.stop",
  "reload",
  "request-help",
  "screenshot",
  "screenshot.manual.frame",
  "screenshot.manual.save",
  "screenshot.manual.start",
  "scroll-to",
  "select",
  "shadow.click",
  "shadow.read",
  "snapshot",
  "step",
  "tab.borrow",
  "tab.close",
  "tab.list",
  "tab.move",
  "tab.new",
  "tab.return",
  "tab.select",
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
  "wait-for-element",
  "wait-for-navigation",
  "wait-ms",
  "wheel",
  "window.close",
  "window.ensureAgent",
  "window.focus",
  "window.list",
  "window.newAgent",
  "window.resize"
]);
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
      "vom"
    ]
  },
  "console": {
    "required": [],
    "properties": [
      "limit",
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
      "force",
      "ref",
      "selector",
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
      "value",
      "waitTimeoutMs"
    ]
  },
  "read": {
    "required": [],
    "properties": [
      "all",
      "fieldsJson",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "evaluate": {
    "required": [
      "expression"
    ],
    "properties": [
      "expression",
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
      "deltaY"
    ]
  },
  "drag": {
    "required": [],
    "properties": [
      "capture",
      "imageDx",
      "imageDy",
      "imageX",
      "imageY",
      "modifiers",
      "steps",
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
      "maxBytes",
      "maxRows",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "extract.discover": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "extract.table": {
    "required": [],
    "properties": [
      "maxBytes",
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
      "itemSelector",
      "maxBytes",
      "maxRows",
      "ref",
      "selector",
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
      "selector",
      "session",
      "sessionId",
      "tabId",
      "visualIndex"
    ]
  },
  "record.start": {
    "required": [],
    "properties": [
      "includeAgent",
      "maxPageTokens",
      "purpose",
      "screenshots",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "record.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
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
  "video.start": {
    "required": [],
    "properties": [
      "durationMs",
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
      "tabId"
    ]
  },
  "navigate-back": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "navigate-forward": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
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
      "tabId"
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
      "tabId",
      "text"
    ]
  },
  "upload": {
    "required": [],
    "properties": [
      "expectRevision",
      "files",
      "paths",
      "ref",
      "selector",
      "session",
      "sessionId",
      "tabId"
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
      "incognito",
      "noFocus",
      "session",
      "sessionId",
      "tabId",
      "url",
      "windowId"
    ]
  },
  "tab.close": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.select": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "tab.borrow": {
    "required": [],
    "properties": [
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
      "tabId"
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
      "tabId"
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
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "network.replay": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.start": {
    "required": [],
    "properties": [
      "bodies",
      "name",
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.stop": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.current": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
    ]
  },
  "debug.request": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
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
  "record.status": {
    "required": [],
    "properties": [
      "session",
      "sessionId",
      "tabId"
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
      "session",
      "sessionId",
      "tabId",
      "timeoutMs"
    ]
  },
  "operation.cancel": {
    "required": [],
    "properties": [
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
      "device",
      "dpr",
      "geolocation",
      "height",
      "locale",
      "mobile",
      "reset",
      "session",
      "sessionId",
      "tabId",
      "timezone",
      "touch",
      "ua",
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
  }
};
export const PARAM_ALIASES = {
  "observe": {
    "closed_shadow": "closedShadow",
    "compare_ax": "compareAx",
    "debug_surfaces": "debugSurfaces",
    "fallback_ax": "fallbackAx",
    "max_depth": "maxDepth",
    "max_tokens": "maxTokens",
    "probe_hover": "probeHover",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "console": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "navigate": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wait-ms": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wait-for-element": {
    "operation_id": "operationId",
    "session_id": "sessionId",
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
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "click-backend": {
    "backend_id": "backendId",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "hover": {
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "fill": {
    "no_clear": "noClear",
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "press": {
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "select": {
    "wait_timeout_ms": "waitTimeoutMs"
  },
  "read": {
    "fields_json": "fieldsJson",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "evaluate": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "wheel": {
    "delta_x": "deltaX",
    "delta_y": "deltaY"
  },
  "drag": {
    "image_dx": "imageDx",
    "image_dy": "imageDy",
    "image_x": "imageX",
    "image_y": "imageY",
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
  "plan": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract": {
    "max_bytes": "maxBytes",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract.discover": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract.table": {
    "max_bytes": "maxBytes",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "extract.list": {
    "item_selector": "itemSelector",
    "max_bytes": "maxBytes",
    "max_rows": "maxRows",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "screenshot": {
    "full_page": "fullPage",
    "grid_step": "gridStep",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "visual_index": "visualIndex"
  },
  "record.start": {
    "include_agent": "includeAgent",
    "max_page_tokens": "maxPageTokens",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "record.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "record.list": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "video.start": {
    "duration_ms": "durationMs",
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
    "tab_id": "tabId"
  },
  "navigate-back": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "navigate-forward": {
    "session_id": "sessionId",
    "tab_id": "tabId"
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
    "tab_id": "tabId"
  },
  "blur": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "focus": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "get-html": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "scroll-to": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "shadow.read": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "shadow.click": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "upload": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "download": {
    "expect_revision": "expectRevision",
    "session_id": "sessionId",
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
    "no_focus": "noFocus",
    "session_id": "sessionId",
    "tab_id": "tabId",
    "window_id": "windowId"
  },
  "tab.close": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.select": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.borrow": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "tab.return": {
    "session_id": "sessionId",
    "tab_id": "tabId"
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
    "tab_id": "tabId"
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
  "network.replay": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.start": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.stop": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.current": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.request": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "debug.performance": {
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
  "record.status": {
    "session_id": "sessionId",
    "tab_id": "tabId"
  },
  "cooperate.sync": {
    "context_lines": "contextLines",
    "match_text": "matchText",
    "probe_hover": "probeHover",
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
    "session_id": "sessionId",
    "tab_id": "tabId"
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
  }
};

export function methodEffect(method) { return METHOD_EFFECT[method] || null; }
export function isKnownMethod(method) { return Object.prototype.hasOwnProperty.call(METHOD_EFFECT, method); }

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
