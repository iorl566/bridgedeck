"""BrowserBridge Python SDK

与 Node SDK 对齐的薄封装：直接调用本地 daemon 的 HTTP /rpc，保留协议错误码与
session 语义。API 形状尽量接近 Playwright 的 ``browser.new_page()`` / ``page.*``。

用法::

    from browser_bridge import connect

    bb = connect()
    page = bb.new_page()
    page.goto("https://example.com")
    page.fill("#q", "browser bridge")
    page.press("Enter")
    print(page.observe()["observation"])
    page.close()

零第三方依赖：只用 Python 标准库（urllib / json / subprocess）。
"""

from __future__ import annotations

import base64
import json
import math
import os
import queue
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

DEFAULT_TIMEOUT = 60.0
START_TIMEOUT = 12.0
SDK_DIR = Path(__file__).resolve().parent
REPO_ROOT = SDK_DIR.parent.parent

# error-codes:begin
# 协议错误码；未知码在传输层归一为 E_INTERNAL。
ERROR_CODES = frozenset({
    'E_BAD_ARG',
    'E_NOT_FOUND',
    'E_NOT_ACTIONABLE',
    'E_STALE_REF',
    'E_OPTION_NOT_FOUND',
    'E_OPTION_AMBIGUOUS',
    'E_UNKNOWN_METHOD',
    'E_NO_SESSION',
    'E_SESSION_BUSY',
    'E_SESSION_PAUSED',
    'E_SESSION_STOPPED',
    'E_QUEUE_FULL',
    'E_RATE_LIMITED',
    'E_CANCELLED',
    'E_REQUEST_CANCELLED',
    'E_INPUT_BUSY',
    'E_NO_TAB',
    'E_NO_BROWSER',
    'E_BROWSER_AMBIGUOUS',
    'E_START_PENDING',
    'E_START_NOT_READY',
    'E_OBSERVATION_STALE',
    'E_CURSOR_STALE',
    'E_CONTEXT_REQUIRED',
    'E_CONTEXT_STALE',
    'E_COOPERATION_STALE',
    'E_CONTROL_CONTEXT_INVALID',
    'E_UNSUPPORTED_FEATURE',
    'E_DEPENDS_FAILED',
    'E_EXPECT_FAILED',
    'E_OBSERVATION_CHANGED',
    'E_TARGET_DETACHED',
    'E_TOKEN_BAD_ARG',
    'E_TOKEN_UNKNOWN',
    'E_TOKEN_EXPIRED',
    'E_TOKEN_USED',
    'E_TOKEN_GRANTEE',
    'E_TOKEN_CAPACITY',
    'E_CAPTURE_BAD_TAB',
    'E_CAPTURE_LIMIT',
    'E_SESSION_STATE',
    'E_SESSION_TRANSITION',
    'E_LEDGER_IO',
    'E_LEDGER_WAL_IO',
    'E_LEDGER_FSYNC',
    'E_LEDGER_RECOVER',
    'E_LEDGER_CONFLICT',
    'E_LEDGER_RESOLVE_REQUIRED',
    'E_TAB_LEASE_HELD',
    'E_TAB_LEASE_NOT_HELD',
    'E_SNAPSHOT_DISABLED',
    'E_SNAPSHOT_WRITE',
    'E_SNAPSHOT_CORRUPT',
    'E_UNSUPPORTED',
    'E_ARG_MISSING',
    'E_ARG_TYPE',
    'E_ARG_ENUM',
    'E_ARG_CONFLICT',
    'E_ARG_REQUIRES',
    'E_ARG_RANGE',
    'E_ARG_UNEXPECTED',
    'E_ARG_USAGE',
    'E_UNKNOWN_FLAG',
    'E_BAD_SUBCOMMAND',
    'E_HUMAN_GATE',
    'E_EVAL_CORPUS',
    'E_EVAL_RUNNER',
    'E_EVAL_DOM',
    'E_EVAL_DOM_ARGS',
    'E_EVAL_DOM_BAD_FACTS',
    'E_EVAL_DOM_BAD_JSON',
    'E_EVAL_DOM_FIXTURE',
    'E_EVAL_DOM_NO_BROWSER',
    'E_EVAL_DOM_NO_FACTS',
    'E_EVAL_DOM_NO_MARKER',
    'E_EVAL_DOM_SPAWN',
    'E_OCCLUDED',
    'E_OBSCURED',
    'E_TARGET_MISMATCH',
    'E_CAPTURE_STALE',
    'E_BAD_MODE',
    'E_DIALOG_PENDING',
    'E_EXISTS',
    'E_CACHE_EMPTY',
    'E_TOO_LARGE',
    'E_RESULT_TOO_LARGE',
    'E_JS_ERROR',
    'E_NAV_FAIL',
    'E_TIMEOUT',
    'E_DEBUGGER_BUSY',
    'E_UNSUPPORTED_CAPABILITY',
    'E_UNSUPPORTED_REMOTE',
    'E_PROTOCOL_UNSUPPORTED',
    'E_PROTOCOL_AUDIT',
    'E_AUTH',
    'E_AUTH_BUSY',
    'E_AUTH_CHALLENGE',
    'E_AUTH_EXPIRED',
    'E_AUTH_FAILED',
    'E_AUTH_PROOF',
    'E_AUTH_STATE',
    'E_PAIR_INVALID',
    'E_PAIR_REQUIRED',
    'E_PAIR_REJECTED',
    'E_PAUSED_MANUAL',
    'E_LEDGER_PENDING',
    'E_DAEMON',
    'E_NO_DAEMON',
    'E_DAEMON_TIMEOUT',
    'E_DISCONNECTED',
    'E_EXTENSION_GONE',
    'E_LISTEN',
    'E_SPAWN',
    'E_ENV',
    'E_CONFIG_INVALID',
    'E_BAD_JSON',
    'E_BAD_REQUEST',
    'E_INVALID_PARAMS',
    'E_DIRECT_RPC_DISABLED',
    'E_RPC',
    'E_OUTPUT',
    'E_TARGET_NOT_FILLABLE',
    'E_NOT_SELECT',
    'E_BROWSER',
    'E_SCREENSHOT',
    'E_PREVIEW_META',
    'E_CLICK',
    'E_KEY',
    'E_FOCUS',
    'E_PAGE_ERROR',
    'E_OBSERVE_FAILED',
    'E_FOLLOW_FAILED',
    'E_RELEASE_INVALID',
    'E_UPDATE',
    'E_MCP_CONFLICT',
    'E_APP_SSO_FAILED',
    'E_TRANSFER_NOT_FOUND',
    'E_TRANSFER_STATE',
    'E_BORROW_DENIED',
    'E_BORROW_CONFLICT',
    'E_BORROW_TIMEOUT',
    'E_HELP_DISABLED',
    'E_CONTROL_NOT_HELD',
    'E_CONTROL_BUSY',
    'E_CONTROL_STALE',
    'E_NO_DOWNLOAD',
    'E_DOWNLOAD_FAILED',
    'E_NO_FILE_CHOOSER',
    'E_TRANSFER_OFFSET',
    'E_TRANSFER_LIMIT',
    'E_TRANSFER_INCOMPLETE',
    'E_INCOGNITO_UNAVAILABLE',
    'E_RECIPE_NOT_APPROVED',
    'E_RECIPE_CHANGED',
    'E_RECIPE_EXPIRED',
    'E_RECIPE_DRAFT_EMPTY',
    'E_RECIPE_LOCKED',
    'E_FORBIDDEN',
    'E_READ_ONLY',
    'E_EXEC_FAILED',
    'E_INTERNAL',
})
# error-codes:end

# ---------------------------------------------------------------------------
# W4-A：协议能力契约（feature floor / 方法特性门 / 参数级门 / 分页标记 / 恢复建议）
#
# 这些表由 lib/method-catalog.mjs、lib/error-codes.mjs 单一来源生成并校验：
# tests/unit/sdk-python-contract.test.mjs 解析下面的 begin/end 块，与 Node/Python
# 两套 SDK 和协议目录逐项对账，任何漂移都会 fail。
# ---------------------------------------------------------------------------

# feature-floors:begin
FEATURE_FLOORS = {
    'unverified': '1.9',
    'expect': '1.9',
    'read': '1.9',
    'observe-delta': '1.9',
    'plan': '1.9',
    'video': '1.9',
    'capture.stream': '1.9',
    'debug.journal': '1.9',
    'har': '1.9',
    'borrow_confirmation_timeout': '1.9',
    'interaction_policy': '1.9',
    'incognito_sessions': '1.9',
    'dialog_control': '1.9',
    'click_move_click': '1.9',
    'target_control': '1.9',
}
# feature-floors:end

# method-features:begin
METHOD_FEATURE = {
    'read': 'read',
    'plan': 'plan',
    'video.start': 'video',
    'video.stop': 'video',
    'video.status': 'video',
    'video.list': 'video',
    'video.fetch': 'video',
    'video.discard': 'video',
    'video.prune': 'video',
    'video.recover': 'video',
    'video.verify': 'video',
    'screenshot.read': 'capture.stream',
    'screenshot.release': 'capture.stream',
    'longshot.recover': 'capture.stream',
    'debug.history': 'debug.journal',
    'debug.delete': 'debug.journal',
    'debug.pin': 'debug.journal',
    'debug.pinned': 'debug.journal',
    'network.replay': 'har',
    'request-help': 'interaction_policy',
    'dialog.arm': 'dialog_control',
    'dialog.disarm': 'dialog_control',
    'dialog.accept': 'dialog_control',
    'dialog.dismiss': 'dialog_control',
    'dialog.handle': 'dialog_control',
    'dialog.list': 'dialog_control',
    'dialog.status': 'dialog_control',
    'operation.await': 'dialog_control',
    'operation.cancel': 'dialog_control',
}
# method-features:end

# 参数级特性门：满足参数形态就要求对应特性（与 lib/method-catalog.mjs 的
# FEATURE_PARAM_RULES 同义；methods 为空表示对所有方法生效）。
FEATURE_PARAM_RULES = (
    ('unverified', 'unverified', 'true', ()),
    ('expect', 'expect', 'non-empty-array', ()),
    ('observe-delta', 'delta', 'true', ()),
    ('capture.stream', 'stream', 'true', ('screenshot',)),
    ('capture.stream', 'segmented', 'true', ('screenshot',)),
    ('capture.stream', 'staleAttempts', 'defined', ('screenshot',)),
)

# partial-methods:begin
PARTIAL_METHODS = frozenset({
    'observe',
    'observe-frames',
    'extract',
    'extract.discover',
    'extract.table',
    'extract.list',
    'console',
    'network.list',
    'screenshot',
    'screenshot.read',
    'longshot.recover',
    'network.waterfall',
})
# partial-methods:end

# 分页工具 → 方法：SDK 调用方按工具名就能判断结果是否可能被截断。
# paginated-tools:begin
PAGINATED_TOOLS = {
    'browser_brief': ('observe',),
    'browser_observe': ('observe',),
    'browser_extract': ('extract',),
    'browser_screenshot': ('screenshot',),
    'browser_longshot_recover': ('longshot.recover',),
    'browser_network_waterfall': ('network.waterfall',),
    'browser_network_list': ('network.list',),
    'browser_console': ('console',),
}
# paginated-tools:end

# 高频失败码 → (retry, hint)；与 lib/error-codes.mjs 的 ERROR_RECOVERY 对齐。
# recovery-hints:begin
RECOVERY_HINTS = {
    'E_STALE_REF': ('after-action', "ref 已失效：重新 observe"),
    'E_OBSERVATION_STALE': ('after-action', "观测过期：重新 observe"),
    'E_OBSERVATION_CHANGED': ('after-action', "页面已变化：重新 observe 后重试"),
    'E_CAPTURE_STALE': ('after-action', "capture 已失效：重新截图"),
    'E_SESSION_PAUSED': ('after-action', "人工接管中：session resume 后重试"),
    'E_LEDGER_PENDING': ('after-action', "先 ledger resolve <id> --outcome done|abandoned"),
    'E_NO_SESSION': ('after-action', "先 bridge session start（或 bridge open <url>）"),
    'E_TIMEOUT': ('after-action', "加 --timeout，或先确认页面是否卡住"),
    'E_OCCLUDED': ('after-action', "先关浮层/弹窗，或用 --force"),
    'E_OBSCURED': ('after-action', "落点被遮挡：重新截图取坐标"),
    'E_TARGET_MISMATCH': ('after-action', "坐标落在别的元素上：重新 observe/截图"),
    'E_NOT_ACTIONABLE': ('after-action', "目标不可操作：先等它可见/启用，或换目标"),
    'E_NOT_FOUND': ('after-action', "重新 observe 确认目标是否还在"),
    'E_PROTOCOL_UNSUPPORTED': ('no', ""),
    'E_PROTOCOL_AUDIT': ('no', "协议审计自检失败：按 proof obligations / 兼容矩阵 / 迁移计划报告修复不变量后再试"),
    # transient：可自动退避重试（与 Node ERROR_RECOVERY 逐条一致，供 retry_plan 对齐）
    'E_SESSION_BUSY': ('transient', "同一会话有进行中的操作，稍等再用"),
    'E_INPUT_BUSY': ('transient', "输入通道忙，稍后重试"),
    'E_RECIPE_LOCKED': ('transient', "另一个 recipe 回放正在进行：等它结束（或删掉 <name>.lock）后重试"),
    'E_NAV_FAIL': ('transient', "导航失败，确认 URL 可达后重试"),
    'E_DISCONNECTED': ('transient', "连接断开，稍后重试"),
    'E_RATE_LIMITED': ('transient', "被限流，退避后重试"),
    'E_QUEUE_FULL': ('transient', "队列满，稍后重试"),
    # 其余与 Node ERROR_RECOVERY 对齐的码（三方契约测试逐条核对 retry/hint）
    'E_BAD_ARG': ('no', "检查参数组合"),
    'E_CONTEXT_STALE': ('after-action', "上下文已失效：重新 cooperate sync 取新 context"),
    'E_TARGET_DETACHED': ('after-action', "目标节点已被移除：重新 observe/cooperate sync 后用新 ref"),
    'E_COOPERATION_STALE': ('after-action', "协作 authority 无法对齐：刷新页面或重开会话后重新 cooperate sync"),
    'E_CONTROL_CONTEXT_INVALID': ('after-action', "重新 cooperate sync 取新的 context_id（上下文换代后旧 id 失效）"),
    'E_UNSUPPORTED_FEATURE': ('no', "升级扩展到支持的协议版本/feature，或去掉该 feature 参数降级执行"),
    'E_TOKEN_EXPIRED': ('after-action', "passthrough 租约已过期：重新申请一次 passthrough 再试"),
    'E_TOKEN_USED': ('after-action', "租约只能消费一次：重新申请 passthrough"),
    'E_TOKEN_UNKNOWN': ('after-action', "租约不存在或已被清理：重新申请 passthrough"),
    'E_TOKEN_GRANTEE': ('no', "租约绑定到其它 tab：用签发它的 tab 消费"),
    'E_CAPTURE_LIMIT': ('after-action', "抑制引用过多：检查是否有未释放的 withOverlaysHidden"),
    'E_NO_TAB': ('after-action', "tab 已被关闭：重新开一个会话/标签页"),
    'E_EXPECT_FAILED': ('no', "断言不符：核对页面实际内容再决定"),
    'E_EXTENSION_GONE': ('after-action', "扩展断开：确认浏览器里的扩展已加载"),
    'E_NO_DAEMON': ('after-action', "daemon 未运行：先启动 daemon"),
    'E_DAEMON': ('after-action', "daemon 不可用：先启动 daemon"),
    'E_PAIR_REQUIRED': ('after-action', "先完成本机配对（bridge pair）"),
    'E_PAIR_REJECTED': ('no', "token 绑定的是另一个浏览器：在目标浏览器重新配对"),
    'E_FORBIDDEN': ('no', "被策略禁止，换做法或征求用户同意"),
    'E_READ_ONLY': ('no', "只读会话不能点击/输入；需要变更时新建 control scope 会话"),
    'E_UNSUPPORTED_CAPABILITY': ('no', "当前版本不支持，换能力"),
    'E_UNSUPPORTED_REMOTE': ('no', "远程连接不支持，改用本机"),
    'E_BORROW_DENIED': ('no', "用户拒绝借用，别绕过"),
    'E_BORROW_CONFLICT': ('after-action', "该标签页已被锁定：等当前借用结束或会话停止后再试"),
    'E_CONTROL_NOT_HELD': ('after-action', "共享 tab 的写控制权不在本会话：等租约到期，或让持有者 session handoff 给你"),
    'E_CONTROL_BUSY': ('after-action', "控制权被他人持有：等租约到期（session control 看剩余时间）或请持有者 handoff"),
    'E_CONTROL_STALE': ('after-action', "控制权已换代：重新 session control 读 epoch 后再操作"),
    'E_HELP_DISABLED': ('no', "人工协助不可用，自行处理或询问用户"),
    'E_TOO_LARGE': ('no', "结果过大，缩小范围（--max-rows / --max-tokens）"),
    'E_RESULT_TOO_LARGE': ('no', "结果过大，缩小范围"),
}
# recovery-hints:end

PROTOCOL_CURRENT = '1.9'
PROTOCOL_BASELINE = '1.8'
PROTOCOL_UNSUPPORTED = 'E_PROTOCOL_UNSUPPORTED'

# ---------------------------------------------------------------------------
# 工具级调用面（W5-A 第 3 项）：92 个 MCP 工具目录 + 本地参数校验 + 审批/超时/分页。
#
# 数据块由 sdk/python/gen-tool-catalog.mjs 从 sdk/tool-catalog.mjs（单一来源）生成：
#   node sdk/python/gen-tool-catalog.mjs --check   # 漂移门禁
#   node sdk/python/gen-tool-catalog.mjs --write   # 重新生成
# 运行时用途：
#   - validate_tool_args()：在发 MCP 请求前按同一份 schema 做 E_ARG_* 校验；
#   - call_tool()：按 tier/approval_required 做人工确认闸门，按 timeout_ms 设超时；
#   - pagination_markers()/call_tool_paged()：按 partial 标记续读 cursor。
# Python 不能 import JS，所以这里内嵌数据；契约测试逐项与 Node/MCP 对账。
# ---------------------------------------------------------------------------

# tool-catalog:begin
TOOL_CATALOG_META = {
    'tool_count': 92,
    'protocol': '1.9',
    'tiers': {'read': 36, 'mutate': 49, 'destructive': 7},
    'order': ('browser_brief', 'browser_update_state', 'browser_session_start', 'browser_session_stop', 'browser_audit', 'browser_settings', 'browser_pair', 'browser_install_skill', 'browser_recipe', 'browser_update', 'browser_record_start', 'browser_record_stop', 'browser_record_list', 'browser_status', 'browser_plan', 'browser_observe', 'browser_navigate', 'browser_click', 'browser_click_backend', 'browser_fill', 'browser_read', 'browser_extract', 'browser_evaluate', 'browser_screenshot', 'browser_longshot_recover', 'browser_download', 'browser_upload', 'browser_pdf', 'browser_tabs', 'browser_tab_new', 'browser_tab_close', 'browser_tab_select', 'browser_tab_move', 'browser_refs_negotiate', 'browser_trace_start', 'browser_trace_stop', 'browser_trace_summary', 'browser_debug_start', 'browser_debug_stop', 'browser_debug_analyze', 'browser_debug_evidence', 'browser_debug_journal', 'browser_debug_query', 'browser_debug_archive', 'browser_debug_archives', 'browser_network_replay_har', 'browser_debug_har', 'browser_debug_har_import', 'browser_network_waterfall', 'browser_network_list', 'browser_rule_list', 'browser_rule_add', 'browser_rule_clear', 'browser_rule_set', 'browser_video_start', 'browser_video_stop', 'browser_video_recover', 'browser_video_status', 'browser_video_list', 'browser_video_trim', 'browser_video_info', 'browser_video_split', 'browser_video_merge', 'browser_window', 'browser_wait_for', 'browser_cooperate_sync', 'browser_dialog', 'browser_press', 'browser_hover', 'browser_select', 'browser_drag', 'browser_scroll_to', 'browser_wheel', 'browser_focus', 'browser_blur', 'browser_reload', 'browser_back', 'browser_forward', 'browser_console', 'browser_session_request_prepare', 'browser_session_request_status', 'browser_session_request_claim', 'browser_session_request_cancel', 'browser_tab_borrow', 'browser_tab_return', 'browser_inspect_html', 'browser_assist_emulate', 'browser_assist_request_help', 'browser_assist_operation_await', 'browser_assist_operation_cancel', 'browser_session_browsers', 'browser_session_list'),
}
TOOL_APPROVAL_ALWAYS = ('browser_update',)
TOOL_CATALOG = {
    'browser_brief': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('observe', 'dialog.status'), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('observe',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_update_state': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': (), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (),
        'pagination': None,
    },
    'browser_session_start': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('session.start',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('browser', {'type': 'string'}),
            ('tab', {'type': 'number'}),
            ('focus', {'type': 'boolean'}),
            ('incognito', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_session_stop': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': ('session.stop',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string'}),
            ('keep', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_audit': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('audit.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('limit', {'type': 'number', 'minimum': 1, 'maximum': 500}),
            ('offset', {'type': 'number'}),
        ),
        'pagination': None,
    },
    'browser_settings': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': ('settings.get', 'settings.set'), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('get', 'set')}),
            ('settings', {'type': 'object'}),
        ),
        'pagination': None,
    },
    'browser_pair': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': ('pair.list', 'pair.create', 'pair.redeem', 'pair.revoke'), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('create', 'list', 'redeem', 'revoke')}),
            ('code', {'type': 'string'}),
            ('ttl', {'type': 'string'}),
            ('label', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_install_skill': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': (), 'required': (), 'additional_properties': False,
        'open_world': False, 'idempotent': False,
        'props': (
            ('target', {'type': 'string'}),
            ('dir', {'type': 'string'}),
            ('force', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_recipe': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': (), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('list', 'show', 'save', 'approve', 'run', 'rm')}),
            ('name', {'type': 'string'}),
            ('file', {'type': 'string'}),
            ('params', {'type': 'object'}),
            ('confirm_human', {'type': 'boolean'}),
            ('by', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_update': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': True, 'timeout_ms': 300000,
        'methods': (), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('state', 'check', 'fetch', 'auto')}),
            ('source', {'type': 'string'}),
            ('out', {'type': 'string'}),
            ('key', {'type': 'string'}),
            ('enable', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_record_start': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('record.start',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('purpose', {'type': 'string'}),
            ('max_page_tokens', {'type': 'integer', 'minimum': 1}),
            ('screenshots', {'type': 'boolean'}),
            ('include_agent', {'type': 'boolean'}),
            ('url', {'type': 'string'}),
            ('redact_values', {'type': 'boolean'}),
            ('trace_version', {'type': 'integer', 'enum': (2, 3)}),
            ('supports_tab_switch_steps', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_record_stop': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('record.stop',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_record_list': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('record.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_status': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('status',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (),
        'pagination': None,
    },
    'browser_plan': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 180000,
        'methods': ('plan',), 'required': ('steps',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('steps', {'type': 'array'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_observe': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('observe',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('probe_hover', {'type': 'boolean'}),
            ('debug_surfaces', {'type': 'boolean'}),
            ('closed_shadow', {'type': 'boolean'}),
            ('vom', {'type': 'boolean'}),
            ('vom_deep', {'type': 'boolean'}),
            ('vom_tree', {'type': 'boolean'}),
            ('vom_rank', {'type': 'boolean'}),
            ('vom_explain', {'type': 'boolean'}),
            ('vom_exclude_hidden', {'type': 'boolean'}),
            ('vom_profile', {'type': 'string', 'enum': ('balanced', 'compact', 'all')}),
            ('vom_per_group', {'type': 'integer', 'minimum': 1}),
            ('vom_group_tokens', {'type': 'integer', 'minimum': 1}),
            ('vom_billing_model', {'type': 'string', 'enum': ('cjk-heuristic-v2', 'chars-per-4', 'o200k')}),
            ('vom_semantic_max_groups', {'type': 'integer', 'minimum': 1}),
            ('vom_semantic_min_score', {'type': 'number', 'minimum': -1000, 'maximum': 1000}),
            ('vom_semantic_max_tokens', {'type': 'integer', 'minimum': 1}),
            ('vom_group_context', {'type': 'boolean'}),
            ('vom_weights', {'type': 'object'}),
            ('vom_top', {'type': 'integer', 'minimum': 1, 'maximum': 500}),
            ('vom_min_score', {'type': 'number', 'minimum': -1000, 'maximum': 1000}),
            ('vom_max_nodes', {'type': 'integer', 'minimum': 1, 'maximum': 5000}),
            ('vom_max_tokens', {'type': 'integer', 'minimum': 1, 'maximum': 200000}),
            ('deep_max_tokens', {'type': 'integer', 'minimum': 1, 'maximum': 20000}),
            ('ax', {'type': 'boolean'}),
            ('facts', {'type': 'boolean'}),
            ('fallback_ax', {'type': 'boolean'}),
            ('compare_ax', {'type': 'boolean'}),
            ('pipeline', {'type': 'string', 'enum': ('page-lib', 'ax')}),
            ('max_tokens', {'type': 'integer', 'minimum': 1, 'maximum': 20000}),
            ('max_depth', {'type': 'integer', 'minimum': 1, 'maximum': 100}),
            ('cursor', {'type': 'string', 'minLength': 1, 'maxLength': 4096}),
            ('force', {'type': 'boolean'}),
            ('delta', {'type': 'boolean'}),
            ('baseline', {'type': 'string'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('observe',),
            'cursor_param': 'cursor',
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_navigate': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('navigate',), 'required': ('url',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('url', {'type': 'string', 'minLength': 1, 'maxLength': 8192}),
        ),
        'pagination': None,
    },
    'browser_click': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('click',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('text', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('trusted', {'type': 'boolean'}),
            ('force', {'type': 'boolean'}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('button', {'type': 'string', 'enum': ('left', 'middle', 'right')}),
            ('click_count', {'type': 'integer', 'minimum': 1, 'maximum': 10}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_click_backend': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('click-backend',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('backend_id', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_fill': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('fill',), 'required': ('value',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('value', {'type': 'string'}),
            ('no_clear', {'type': 'boolean'}),
            ('trusted', {'type': 'boolean'}),
            ('force', {'type': 'boolean'}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_read': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('read',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('all', {'type': 'boolean'}),
            ('fields_json', {'type': 'string'}),
            ('fields', {'type': 'array', 'maxItems': 32, 'items_type': 'object'}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('max_nodes', {'type': 'integer', 'minimum': 1, 'maximum': 10000}),
            ('max_bytes', {'type': 'integer', 'minimum': 1, 'maximum': 67108864}),
        ),
        'pagination': None,
    },
    'browser_extract': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('extract',), 'required': ('selector',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('max_rows', {'type': 'integer', 'minimum': 1}),
            ('max_bytes', {'type': 'integer', 'minimum': 1}),
            ('max_cells', {'type': 'integer', 'minimum': 1}),
            ('max_columns', {'type': 'integer', 'minimum': 1}),
            ('cursor', {'type': 'string', 'minLength': 1}),
            ('action', {'type': 'string', 'enum': ('table', 'list', 'discover')}),
            ('target_id', {'type': 'string', 'minLength': 1}),
            ('item_selector', {'type': 'string', 'minLength': 1}),
            ('fields', {'type': 'array', 'maxItems': 64, 'items_type': 'object'}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('extract',),
            'cursor_param': 'cursor',
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_evaluate': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': ('evaluate',), 'required': ('expression',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('expression', {'type': 'string', 'minLength': 1, 'maxLength': 200000}),
            ('unverified', {'type': 'boolean'}),
            ('await_promise', {'type': 'boolean'}),
            ('return_by_value', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_screenshot': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 180000,
        'methods': ('screenshot',), 'required': ('out',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('out', {'type': 'string'}),
            ('full_page', {'type': 'boolean'}),
            ('scope', {'type': 'string', 'enum': ('viewport', 'full', 'follow', 'current')}),
            ('tile_size', {'type': 'integer', 'minimum': 256, 'maximum': 8192}),
            ('stale_attempts', {'type': 'integer', 'minimum': 1, 'maximum': 3}),
            ('segmented', {'type': 'boolean'}),
            ('selector', {'type': 'string'}),
            ('region', {'type': ('string', 'object')}),
            ('annotate', {'type': 'boolean'}),
            ('overlap', {'type': 'number'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('screenshot',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_longshot_recover': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 180000,
        'methods': ('longshot.recover',), 'required': ('longshot_id', 'out'), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('longshot_id', {'type': 'string'}),
            ('out', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('longshot.recover',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_download': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('download',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('target', {'type': 'string'}),
            ('url', {'type': 'string'}),
            ('out', {'type': 'string'}),
            ('overwrite', {'type': 'boolean'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_upload': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 180000,
        'methods': ('upload',), 'required': ('target', 'files'), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('target', {'type': 'string'}),
            ('files', {'type': 'array', 'minItems': 1, 'maxItems': 20, 'items_type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_pdf': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 90000,
        'methods': ('pdf',), 'required': ('out',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('out', {'type': 'string'}),
            ('landscape', {'type': 'boolean'}),
            ('print_background', {'type': 'boolean'}),
            ('page_ranges', {'type': 'string'}),
            ('margins', {'type': 'object'}),
            ('scale', {'type': 'number', 'minimum': 0.1, 'maximum': 2}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_tabs': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('tab.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('scope', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_tab_new': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('tab.new',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('url', {'type': 'string'}),
            ('new_window', {'type': 'boolean'}),
            ('no_focus', {'type': 'boolean'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_tab_close': {
        'tier': 'destructive', 'approval_required': True, 'approval_always': False, 'timeout_ms': 300000,
        'methods': ('tab.close',), 'required': ('tab_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_tab_select': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('tab.select',), 'required': ('tab_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_tab_move': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('tab.move',), 'required': ('tab_id', 'window_id'), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('window_id', {'type': 'integer', 'minimum': 0}),
            ('index', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_refs_negotiate': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('refs.negotiate',), 'required': ('stable_refs',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('stable_refs', {'type': 'array', 'minItems': 1, 'maxItems': 50, 'items_type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_trace_start': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('trace.start',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('categories', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_trace_stop': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('trace.stop',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('output', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_trace_summary': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('file',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('file', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_start': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('debug.start',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('name', {'type': 'string'}),
            ('id', {'type': 'string'}),
            ('bodies', {'type': 'boolean'}),
            ('action', {'type': 'string'}),
            ('run_id', {'type': 'string'}),
            ('since', {'type': 'integer', 'minimum': 0}),
            ('limit', {'type': 'integer', 'minimum': 1, 'maximum': 100}),
            ('part', {'type': 'string'}),
            ('offset', {'type': 'integer', 'minimum': 0, 'maximum': 65536}),
            ('max_chars', {'type': 'integer', 'minimum': 1, 'maximum': 16384}),
            ('pointer', {'type': 'string'}),
            ('rule', {'type': 'object'}),
            ('replay', {'type': 'object'}),
            ('budget', {'type': 'integer', 'minimum': 4096, 'maximum': 262144}),
            ('slow_ms', {'type': 'integer', 'minimum': 0, 'maximum': 60000}),
            ('window_ms', {'type': 'integer', 'minimum': 100, 'maximum': 10000}),
            ('include_controlled', {'type': 'boolean'}),
            ('url', {'type': 'string'}),
            ('method', {'type': 'string'}),
            ('resource_type', {'type': 'string'}),
            ('status', {'type': 'integer', 'minimum': 100, 'maximum': 599}),
            ('state', {'type': 'string'}),
            ('kind', {'type': 'string'}),
            ('fields', {'type': 'array', 'items_type': 'string'}),
            ('wait_ms', {'type': 'integer', 'minimum': 0, 'maximum': 60000}),
            ('command_id', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_stop': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('debug.stop',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('trace', {'type': None}),
            ('trace_origin', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_debug_analyze': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': (), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('file', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_evidence': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('out',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('out', {'type': 'string'}),
            ('file', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_journal': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': (), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('limit', {'type': 'number'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_query': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('file',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('file', {'type': 'string'}),
            ('filter', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_archive': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('out',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('out', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_archives': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('dir',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('dir', {'type': 'string'}),
            ('prune', {'type': 'boolean'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_network_replay_har': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('network.replay',), 'required': ('file',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('file', {'type': 'string'}),
            ('entry', {'type': 'integer', 'minimum': 0}),
            ('filter', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_har': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('out',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('out', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_debug_har_import': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': (), 'required': ('file', 'out'), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('file', {'type': 'string'}),
            ('out', {'type': 'string'}),
            ('name', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_network_waterfall': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('network.waterfall',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('limit', {'type': 'integer', 'minimum': 1, 'maximum': 2000}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('network.waterfall',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_network_list': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('network.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('filter', {'type': 'object'}),
            ('since', {'type': 'integer', 'minimum': 0}),
            ('limit', {'type': 'integer', 'minimum': 1}),
            ('filter_text', {'type': 'string'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('network.list',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_rule_list': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('debug.rule_list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_rule_add': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('debug.rule_add',), 'required': ('rule',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('rule', {'type': 'object'}),
        ),
        'pagination': None,
    },
    'browser_rule_clear': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('debug.rule_clear',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_rule_set': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('debug.rule_add', 'debug.rule_enable', 'debug.rule_disable', 'debug.rule_remove'), 'required': ('action', 'id'), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('enable', 'disable', 'remove')}),
            ('id', {'type': 'integer'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_start': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('video.start',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('duration_ms', {'type': 'integer', 'minimum': 0}),
            ('quality', {'type': 'string'}),
            ('encoder', {'type': 'string', 'enum': ('avc',)}),
            ('force_frames', {'type': 'boolean'}),
            ('max_duration_ms', {'type': 'integer', 'minimum': 1}),
            ('max_segment_bytes', {'type': 'integer', 'minimum': 1}),
            ('max_total_bytes', {'type': 'integer', 'minimum': 1}),
            ('max_concurrent', {'type': 'integer', 'minimum': 1}),
            ('duration', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_stop': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('video.stop',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('recording', {'type': 'string'}),
            ('recording_id', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_recover': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 300000,
        'methods': (), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_status': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('video.status',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('recording', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_list': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('video.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_video_trim': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 300000,
        'methods': (), 'required': ('input', 'out'), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('input', {'type': 'string'}),
            ('out', {'type': 'string'}),
            ('start', {'type': 'string'}),
            ('end', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_info': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': (), 'required': ('input',), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('input', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_video_split': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 300000,
        'methods': (), 'required': ('input', 'out_dir'), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('input', {'type': 'string'}),
            ('out_dir', {'type': 'string'}),
            ('parts', {'type': 'integer', 'minimum': 2, 'maximum': 10}),
        ),
        'pagination': None,
    },
    'browser_video_merge': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 600000,
        'methods': (), 'required': ('inputs', 'out'), 'additional_properties': False,
        'open_world': False, 'idempotent': True,
        'props': (
            ('inputs', {'type': 'array', 'minItems': 2, 'items_type': 'string'}),
            ('out', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_window': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('window.list', 'window.focus', 'window.ensureAgent', 'window.resize'), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('action', {'type': 'string', 'enum': ('list', 'focus', 'ensure', 'resize')}),
            ('window_id', {'type': 'number', 'minimum': 0}),
            ('width', {'type': 'number', 'minimum': 1}),
            ('height', {'type': 'number', 'minimum': 1}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_wait_for': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('wait-for-element',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('session_id', {'type': 'string', 'minLength': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 0}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('state', {'type': 'string'}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1, 'maximum': 120000}),
            ('operation_id', {'type': 'string', 'minLength': 1}),
        ),
        'pagination': None,
    },
    'browser_cooperate_sync': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('cooperate.sync',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_dialog': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('dialog.arm', 'dialog.status', 'dialog.accept', 'dialog.dismiss', 'dialog.list', 'dialog.handle'), 'required': ('action',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('action', {'type': 'string', 'enum': ('status', 'accept', 'dismiss', 'arm', 'list')}),
            ('id', {'type': 'number', 'minimum': 1}),
            ('text', {'type': 'string'}),
            ('session', {'type': 'string'}),
            ('alert', {'type': 'string'}),
            ('confirm', {'type': 'string'}),
            ('prompt', {'type': 'string'}),
            ('prompt_text', {'type': 'string'}),
            ('queue', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_press': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('press',), 'required': ('key',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('key', {'type': 'string', 'minLength': 1}),
            ('trusted', {'type': 'boolean'}),
            ('force', {'type': 'boolean'}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_hover': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('hover',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('trusted', {'type': 'boolean'}),
            ('force', {'type': 'boolean'}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_select': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('select',), 'required': ('value',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('value', {'type': 'string'}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_drag': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('drag',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('modifiers', {'type': 'integer', 'minimum': 0, 'maximum': 15}),
            ('steps', {'type': 'integer', 'minimum': 2, 'maximum': 60}),
            ('wait_timeout', {'type': 'integer', 'minimum': 0, 'maximum': 120000}),
            ('capture', {'type': 'string'}),
            ('image_x', {'type': 'integer'}),
            ('image_y', {'type': 'integer'}),
            ('image_dx', {'type': 'integer'}),
            ('image_dy', {'type': 'integer'}),
            ('observation_id', {'type': 'string', 'minLength': 1}),
            ('button', {'type': 'string', 'enum': ('left', 'middle', 'right')}),
            ('source', {'type': 'string', 'minLength': 1}),
            ('mode', {'type': 'string', 'enum': ('hold', 'click-move-click')}),
            ('target', {'type': 'string', 'minLength': 1}),
            ('delta', {'type': 'object'}),
            ('hold_ms', {'type': 'integer', 'minimum': 0, 'maximum': 5000}),
            ('duration_ms', {'type': 'integer', 'minimum': 0, 'maximum': 5000}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_scroll_to': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('scroll-to',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('expect_revision', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_wheel': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('wheel',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('delta_y', {'type': 'number'}),
            ('delta_x', {'type': 'number'}),
            ('modifiers', {'type': 'array', 'maxItems': 8, 'items_type': 'string'}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_focus': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('focus',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('expect_revision', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_blur': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('blur',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('expect_revision', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_reload': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('reload',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_back': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('navigate-back',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_forward': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('navigate-forward',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_console': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('console',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('since', {'type': 'integer', 'minimum': 0}),
            ('limit', {'type': 'integer', 'minimum': 1, 'maximum': 2000}),
            ('max_text_chars', {'type': 'integer', 'minimum': 1}),
            ('include_stack', {'type': 'boolean'}),
        ),
        'pagination': {
            'partial': True,
            'methods': ('console',),
            'cursor_param': None,
            'result_fields': ('cursor', 'truncated', 'partial'),
        },
    },
    'browser_session_request_prepare': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('session.request_prepare',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('request_id', {'type': 'string'}),
            ('browser', {'type': 'string'}),
            ('no_focus', {'type': 'boolean'}),
            ('incognito', {'type': 'boolean'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_session_request_status': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('session.request_status',), 'required': ('request_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('request_id', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_session_request_claim': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('session.request_claim',), 'required': ('request_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('request_id', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_session_request_cancel': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('session.request_cancel',), 'required': ('request_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('request_id', {'type': 'string'}),
            ('session', {'type': 'string'}),
        ),
        'pagination': None,
    },
    'browser_tab_borrow': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('tab.borrow',), 'required': ('tab_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('confirmation_timeout_ms', {'type': 'integer', 'minimum': 1, 'maximum': 600000}),
            ('tab_id', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_tab_return': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('tab.return',), 'required': ('tab_id',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('tab_id', {'type': 'integer', 'minimum': 1}),
        ),
        'pagination': None,
    },
    'browser_inspect_html': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('get-html',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('ref', {'type': 'string', 'minLength': 1}),
            ('selector', {'type': 'string', 'minLength': 1}),
            ('stable_ref', {'type': 'string', 'minLength': 1}),
            ('expect_revision', {'type': 'integer', 'minimum': 0}),
        ),
        'pagination': None,
    },
    'browser_assist_emulate': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('emulate',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('device', {'type': 'string'}),
            ('width', {'type': 'integer', 'minimum': 1}),
            ('height', {'type': 'integer', 'minimum': 1}),
            ('dpr', {'type': 'number', 'minimum': 0}),
            ('mobile', {'type': 'boolean'}),
            ('ua', {'type': 'string'}),
            ('timezone', {'type': 'string'}),
            ('locale', {'type': 'string'}),
            ('geolocation', {'type': 'object'}),
            ('touch', {'type': 'boolean'}),
            ('reset', {'type': 'boolean'}),
        ),
        'pagination': None,
    },
    'browser_assist_request_help': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 620000,
        'methods': ('request-help',), 'required': ('reason',), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('reason', {'type': 'string'}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('criteria', {'type': 'array', 'maxItems': 10, 'items_type': 'object'}),
        ),
        'pagination': None,
    },
    'browser_assist_operation_await': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 330000,
        'methods': ('operation.await',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('id', {'type': 'string', 'minLength': 1}),
            ('timeout_ms', {'type': 'integer', 'minimum': 1}),
            ('operation_id', {'type': 'string', 'minLength': 1}),
        ),
        'pagination': None,
    },
    'browser_assist_operation_cancel': {
        'tier': 'mutate', 'approval_required': False, 'approval_always': False, 'timeout_ms': 120000,
        'methods': ('operation.cancel',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': False,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
            ('id', {'type': 'string', 'minLength': 1}),
            ('operation_id', {'type': 'string', 'minLength': 1}),
        ),
        'pagination': None,
    },
    'browser_session_browsers': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('browsers',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
        ),
        'pagination': None,
    },
    'browser_session_list': {
        'tier': 'read', 'approval_required': False, 'approval_always': False, 'timeout_ms': 60000,
        'methods': ('session.list',), 'required': (), 'additional_properties': False,
        'open_world': True, 'idempotent': True,
        'props': (
            ('session', {'type': 'string', 'minLength': 1}),
        ),
        'pagination': None,
    },
}
# tool-catalog:end


def normalize_error_code(code: Any) -> str:
    """未知错误码统一归一为 E_INTERNAL（与 Node SDK 一致，调用方只按清单分支）。"""
    return code if isinstance(code, str) and code in ERROR_CODES else 'E_INTERNAL'


def _version_parts(version: Any) -> List[int]:
    parts: List[int] = []
    for piece in str(version or '').split('.'):
        try:
            parts.append(int(piece))
        except ValueError:
            parts.append(0)
    return parts


def protocol_supports(version: Any, required: Any) -> bool:
    """协议版本 version 是否满足 required floor（按点分数字比较）。"""
    if not required:
        return True
    left = _version_parts(version)
    right = _version_parts(required)
    for index in range(max(len(left), len(right))):
        diff = (left[index] if index < len(left) else 0) - (right[index] if index < len(right) else 0)
        if diff != 0:
            return diff > 0
    return True


def method_floor(method: str) -> Optional[str]:
    """方法级特性门要求的协议 floor；无方法级门返回 None。"""
    feature = METHOD_FEATURE.get(str(method or ''))
    return FEATURE_FLOORS.get(feature) if feature else None


def _param_rule_matches(param: str, kind: str, bag: Dict[str, Any]) -> bool:
    value = bag.get(param)
    if kind == 'true':
        return value is True
    if kind == 'defined':
        return param in bag and value is not None
    if kind == 'non-empty-array':
        return isinstance(value, list) and len(value) > 0
    return False


def features_for_params(params: Optional[Dict[str, Any]]) -> set:
    """参数形态触发的特性门（只看对所有方法生效的规则：unverified/expect/delta）。"""
    bag = params if isinstance(params, dict) else {}
    features = set()
    for rule_feature, param, kind, methods in FEATURE_PARAM_RULES:
        if methods:
            continue
        if _param_rule_matches(param, kind, bag):
            features.add(rule_feature)
    return features


def features_for_call(method: str, params: Optional[Dict[str, Any]] = None) -> set:
    """一次调用触发的全部特性门：方法级 + 参数级（含截图专属参数）。"""
    features = set()
    feature = METHOD_FEATURE.get(str(method or ''))
    if feature:
        features.add(feature)
    bag = params if isinstance(params, dict) else {}
    for rule_feature, param, kind, methods in FEATURE_PARAM_RULES:
        if methods and str(method or '') not in methods:
            continue
        if _param_rule_matches(param, kind, bag):
            features.add(rule_feature)
    return features


def required_floor(method: str, params: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """一次调用需要的最低协议 floor（取全部触发特性的最大值）。"""
    floor = None
    for feature in features_for_call(method, params):
        candidate = FEATURE_FLOORS.get(feature)
        if candidate and (floor is None or not protocol_supports(floor, candidate)):
            floor = candidate
    return floor


def protocol_gate(version: Any, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """本地能力门禁：返回是否允许、触发的特性、缺失项与所需 floor（不抛异常）。"""
    features = sorted(features_for_call(method, params))
    floor = required_floor(method, params)
    ok = floor is None or protocol_supports(version, floor)
    return {
        "ok": ok,
        "method": str(method or ''),
        "protocol": str(version or ''),
        "features": features,
        "required_floor": floor,
        "missing": [] if ok else [{"feature": feature, "required": FEATURE_FLOORS.get(feature)} for feature in features if not protocol_supports(version, FEATURE_FLOORS.get(feature))],
        "code": None if ok else PROTOCOL_UNSUPPORTED,
    }


def is_partial(method: str) -> bool:
    """方法结果是否可能被截断/分页（调用方不要假设一次拿全量）。"""
    return str(method or '') in PARTIAL_METHODS


def pagination_markers(tool: str) -> Dict[str, Any]:
    """按 MCP 工具名给出分页标记（partial/methods/resultFields/cursorParam）。

    优先读生成目录 TOOL_CATALOG（与 Node/MCP 同源）；未知工具退回静态 PAGINATED_TOOLS，
    保证 Python 侧不出现“目录说分页、调用面说全量”的漂移。
    """
    spec = tool_spec(tool)
    if spec is not None:
        pagination = spec.get("pagination")
        if pagination:
            return {
                "partial": True,
                "methods": list(pagination["methods"]),
                "resultFields": list(pagination["result_fields"]),
                "cursorParam": pagination["cursor_param"],
            }
        return {"partial": False, "methods": [], "resultFields": [], "cursorParam": "cursor"}
    methods = PAGINATED_TOOLS.get(str(tool or ''), ())
    return {
        "partial": bool(methods),
        "methods": list(methods),
        "resultFields": ["cursor", "truncated", "partial"] if methods else [],
        "cursorParam": "cursor",
    }


def next_page_params(tool: str, result: Any) -> Dict[str, Any]:
    """从一次工具结果里提取续读参数；没有下一页时返回空 dict。"""
    if not pagination_markers(tool)["partial"] or not isinstance(result, dict):
        return {}
    cursor = result.get("cursor")
    if cursor is None and isinstance(result.get("partial"), dict):
        cursor = result["partial"].get("cursor")
    if cursor is None and isinstance(result.get("paging"), dict):
        cursor = result["paging"].get("nextCursor")
    return {"cursor": cursor} if cursor else {}


def recovery_advice(code: str) -> Dict[str, str]:
    """错误码 → 下一步建议（与 daemon/MCP 的 recoveryHint 同源）。"""
    retry, hint = RECOVERY_HINTS.get(str(code or ''), ('no', ''))
    return {"retry": retry, "hint": hint}



class BridgeError(Exception):
    """daemon 业务错误；code 为协议错误码，data 保留结构化细节。"""

    def __init__(self, code: str, message: str, data: Any = None, method: Optional[str] = None):
        super().__init__(f"{code}: {message}")
        self.code = normalize_error_code(code)
        self.message = message
        self.data = data
        self.method = method
        self.effect_state = None
        if isinstance(data, dict):
            self.effect_state = data.get("effect_state") or data.get("effectState")

    def to_dict(self) -> Dict[str, Any]:
        """结构化错误（日志/重试策略使用）：code/message/method/effect_state/data。"""
        return {
            "code": self.code,
            "message": self.message,
            "method": self.method,
            "effect_state": self.effect_state,
            "retry": recovery_advice(self.code)["retry"],
            "hint": recovery_advice(self.code)["hint"],
            "data": self.data,
        }


class ToolArgumentError(BridgeError):
    """工具入参校验失败（与 MCP server / Node SDK 同一套 E_ARG_* 错误码）。"""

    def __init__(self, errors: List[Dict[str, Any]]):
        first = errors[0] if errors else {"code": "E_ARG_TYPE", "path": "", "message": "参数非法"}
        code = str(first.get("code") or "E_ARG_TYPE")
        path = str(first.get("path") or "<arguments>")
        super().__init__(code, f"{code}: {path} — {first.get('message', '')}", data={"errors": list(errors)})
        self.errors = list(errors)


class ToolCallError(BridgeError):
    """MCP 工具调用失败：保留协议错误码、工具名与 _meta 结构化细节。"""

    def __init__(self, code: str, message: str, tool: Optional[str] = None, details: Any = None):
        super().__init__(code, message, data=details)
        self.tool = tool
        self.details = details

    def to_dict(self) -> Dict[str, Any]:
        payload = super().to_dict()
        payload["tool"] = self.tool
        return payload


# ---------------------------------------------------------------------------
# 工具目录查询 + 本地参数校验（镜像 mcp/tool-args.mjs 的 JSON Schema 子集）
# ---------------------------------------------------------------------------

ARG_ERROR_CODES = {
    "MISSING": "E_ARG_MISSING",
    "TYPE": "E_ARG_TYPE",
    "ENUM": "E_ARG_ENUM",
    "RANGE": "E_ARG_RANGE",
    "UNEXPECTED": "E_ARG_UNEXPECTED",
}

MCP_PROTOCOL_VERSION = "2024-11-05"
MCP_SERVER_PATH = REPO_ROOT / "mcp" / "server.mjs"
APPROVAL_META_KEY = "browser-bridge/approval"
APPROVAL_CONFIRMED = "confirmed"
APPROVAL_ENV = "BB_MCP_APPROVAL"
DEFAULT_PAGE_LIMIT = 8


def tool_spec(name: str) -> Optional[Dict[str, Any]]:
    """单工具目录（name 归一为 str）；未知工具返回 None。"""
    entry = TOOL_CATALOG.get(str(name or ""))
    if entry is None:
        return None
    spec = {"name": str(name)}
    spec.update(entry)
    return spec


def list_tools() -> List[Dict[str, Any]]:
    """92 个 MCP 工具目录（顺序与 MCP tools/list / Node SDK 一致）。"""
    return [tool_spec(name) for name in TOOL_CATALOG_META["order"] if tool_spec(name) is not None]


def tool_tier_summary() -> Dict[str, Any]:
    """分档统计：总数 / read|mutate|destructive / 审批清单 / 分页工具清单。"""
    rows = list_tools()
    return {
        "total": len(rows),
        "byTier": {
            "read": len([row for row in rows if row["tier"] == "read"]),
            "mutate": len([row for row in rows if row["tier"] == "mutate"]),
            "destructive": len([row for row in rows if row["tier"] == "destructive"]),
        },
        "approvals": [row["name"] for row in rows if row["approval_required"]],
        "paginated": [row["name"] for row in rows if row["pagination"]],
    }


def _value_type(value: Any) -> str:
    """JSON 类型名；float 的整数值按 integer 计（与 JSON.parse + Number.isInteger 一致）。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "integer" if value.is_integer() else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _expected_types(expected: Any) -> List[str]:
    if isinstance(expected, (list, tuple)):
        return [str(item) for item in expected]
    return [str(expected)]


def _type_matches(expected: Any, value: Any) -> bool:
    actual = _value_type(value)
    for item in _expected_types(expected):
        if item == "number" and actual in ("number", "integer"):
            return True
        if item == "integer" and actual == "integer":
            return True
        if item not in ("number", "integer") and actual == item:
            return True
    return False


def _describe_value(value: Any) -> str:
    if isinstance(value, str):
        return json.dumps(value if len(value) <= 40 else value[:40] + "…", ensure_ascii=False)
    if isinstance(value, bool):
        return "True" if value else "False"
    if value is None:
        return "None"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return f"array({len(value)})"
    return type(value).__name__


def _validate_value(schema: Dict[str, Any], value: Any, path: str, errors: List[Dict[str, str]]) -> None:
    expected = schema.get("type")
    if expected is not None and not _type_matches(expected, value):
        errors.append({
            "code": ARG_ERROR_CODES["TYPE"],
            "path": path,
            "message": f"期望 {'|'.join(_expected_types(expected))}，实际 {_value_type(value)}（{_describe_value(value)}）",
        })
        return
    if isinstance(schema.get("enum"), (list, tuple)) and not any(candidate == value for candidate in schema["enum"]):
        errors.append({
            "code": ARG_ERROR_CODES["ENUM"],
            "path": path,
            "message": "取值必须是 " + "|".join(json.dumps(item, ensure_ascii=False) for item in schema["enum"]) + "，实际 " + _describe_value(value),
        })
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"不能小于 {schema['minimum']}，实际 {value}"})
        if "maximum" in schema and value > schema["maximum"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"不能大于 {schema['maximum']}，实际 {value}"})
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"长度不能小于 {schema['minLength']}，实际 {len(value)}"})
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"长度不能大于 {schema['maxLength']}，实际 {len(value)}"})
    if isinstance(value, (list, tuple)):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"至少需要 {schema['minItems']} 项，实际 {len(value)}"})
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append({"code": ARG_ERROR_CODES["RANGE"], "path": path, "message": f"最多允许 {schema['maxItems']} 项，实际 {len(value)}"})
        items_type = schema.get("items_type")
        if items_type is not None:
            for index, item in enumerate(value):
                _validate_value({"type": items_type}, item, f"{path}[{index}]", errors)
    if isinstance(value, dict):
        _validate_object(schema, value, path, errors)


def _validate_object(schema: Dict[str, Any], value: Dict[str, Any], path: str, errors: List[Dict[str, str]]) -> None:
    properties = schema.get("properties") or {}
    for name in schema.get("required") or []:
        if name not in value:
            errors.append({"code": ARG_ERROR_CODES["MISSING"], "path": f"{path}.{name}" if path else name, "message": "缺少必填参数"})
    if schema.get("additionalProperties") is False:
        for name in value:
            if name not in properties:
                errors.append({"code": ARG_ERROR_CODES["UNEXPECTED"], "path": f"{path}.{name}" if path else name, "message": "schema 未声明该参数"})
    for name, definition in properties.items():
        if name in value:
            _validate_value(definition, value[name], f"{path}.{name}" if path else name, errors)


def validate_tool_args(name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """按工具 schema 校验入参；返回 {ok, errors}（不抛异常，便于调用方先判断）。"""
    spec = tool_spec(name)
    if spec is None:
        return {"ok": False, "errors": [{"code": ARG_ERROR_CODES["UNEXPECTED"], "path": "name", "message": f"未知工具 {name}"}]}
    bag: Any = {} if args is None else args
    if not isinstance(bag, dict):
        return {"ok": False, "errors": [{"code": ARG_ERROR_CODES["TYPE"], "path": "", "message": "arguments 必须是对象"}]}
    errors: List[Dict[str, str]] = []
    _validate_object(
        {
            "type": "object",
            "properties": {prop_name: definition for prop_name, definition in spec["props"]},
            "required": list(spec["required"]),
            "additionalProperties": spec.get("additional_properties", True),
        },
        bag,
        "",
        errors,
    )
    return {"ok": not errors, "errors": errors}


def assert_tool_args(name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """严格校验：失败抛 ToolArgumentError（带 E_ARG_* 码与结构化 errors）。"""
    result = validate_tool_args(name, args)
    if not result["ok"]:
        raise ToolArgumentError(result["errors"])
    return {} if args is None else args


def _approval_disabled(env: Optional[Dict[str, str]] = None) -> bool:
    value = str((env or os.environ).get(APPROVAL_ENV, "")).strip().lower()
    return value in ("off", "0", "false", "disabled")


# ---------------------------------------------------------------------------
# MCP stdio 传输 + 工具客户端（Python SDK 工具级调用面的运行时）
# ---------------------------------------------------------------------------

class StdioMcpTransport:
    """以 newline-delimited JSON-RPC 2.0 与 `node mcp/server.mjs` 通信。

    设计：单读线程 + 每个请求一个 queue；超时会 kill 子进程并报 E_TIMEOUT，避免
    半开管道让调用方永久阻塞。transport 可被替换（单测注入 fake，不需要 node）。

    除请求/响应外还处理两类 server→client 消息：
      - ``notifications/progress``：分发给 ``add_notification_handler`` 注册的回调，
        请求方用 progressToken 过滤（见 McpToolClient.call_tool）；
      - 取消：``cancel(request_id)`` 发 ``notifications/cancelled`` 并立刻唤醒等待方，
        以 E_CANCELLED 结束请求（server 按 MCP 规范不再回该请求的响应）。
    """

    def __init__(self, command: List[str], cwd: Optional[Union[str, Path]] = None,
                 env: Optional[Dict[str, str]] = None, timeout: float = DEFAULT_TIMEOUT):
        if not command:
            raise BridgeError("E_ENV", "StdioMcpTransport 需要启动命令")
        self.command = [str(item) for item in command]
        self.cwd = str(cwd) if cwd else None
        self.env = dict(env or os.environ)
        self.timeout = float(timeout)
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._pending: Dict[int, "queue.Queue"] = {}
        self._listeners: List[Any] = []
        self._lock = threading.Lock()
        self._seq = 0
        self._closed = False

    def start(self) -> "StdioMcpTransport":
        if self._proc is not None:
            return self
        kwargs: Dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True
        try:
            self._proc = subprocess.Popen(  # noqa: S603 - 命令由 SDK 自身构造（node + mcp/server.mjs）
                self.command,
                cwd=self.cwd,
                env=self.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
                **kwargs,
            )
        except OSError as error:
            raise BridgeError("E_ENV", f"启动 MCP server 失败（需要 node）：{error}") from error
        self._reader = threading.Thread(target=self._read_loop, name="bb-mcp-reader", daemon=True)
        self._reader.start()
        return self

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if "method" in message and "id" not in message:
                    # server→client 通知（progress 等）：不占请求队列，分发给监听者。
                    self._dispatch_notification(message)
                    continue
                with self._lock:
                    box = self._pending.pop(message.get("id"), None)
                if box is not None:
                    box.put(message)
        except (OSError, ValueError):
            pass
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for box in pending:
            box.put(None)

    def _dispatch_notification(self, message: Dict[str, Any]) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(message)
            except Exception:  # noqa: BLE001 - 通知回调失败不能影响读线程
                pass

    def add_notification_handler(self, handler: Any) -> Any:
        """注册 server→client 通知回调（参数是完整 JSON-RPC 消息 dict）；返回同一 handler。"""
        if not callable(handler):
            raise BridgeError("E_ARG_TYPE", "通知回调必须可调用")
        with self._lock:
            self._listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler: Any) -> bool:
        with self._lock:
            for index, listener in enumerate(self._listeners):
                if listener is handler:
                    del self._listeners[index]
                    return True
        return False

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        """发通知（无响应）；server 对 notifications/initialized 不回复。"""
        self.start()
        assert self._proc is not None and self._proc.stdin is not None
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()

    def cancel(self, request_id: int, reason: str = "") -> bool:
        """取消一个已发出、尚未返回的请求。

        发 ``notifications/cancelled`` 后立刻把等待队列唤醒为取消态，调用方以
        E_CANCELLED 结束（MCP 规范：server 不再回该请求的响应）。返回 False 表示
        请求已返回/不存在（取消按规范是尽力而为，不报错）。
        """
        self.start()
        with self._lock:
            box = self._pending.pop(request_id, None)
        if box is None:
            return False
        try:
            self.notify("notifications/cancelled", {"requestId": request_id, "reason": str(reason or "")})
        except (BridgeError, OSError, ValueError):
            # 通知发不出去也要唤醒等待方，避免调用方永久阻塞。
            pass
        try:
            box.put_nowait({"_cancelled": True, "reason": str(reason or "")})
        except queue.Full:
            pass
        return True

    def request(self, method: str, params: Optional[Dict[str, Any]] = None,
                timeout: Optional[float] = None,
                on_start: Optional[Any] = None) -> Any:
        """发请求并等待响应。

        on_start(request_id) 在请求写出后立即调用（可用于从其他线程 cancel）；
        取消时本方法抛 E_CANCELLED，而不是等到 timeout。
        """
        self.start()
        if self._closed or self._proc is None:
            raise BridgeError("E_DISCONNECTED", "MCP 连接已关闭")
        wait = float(timeout or self.timeout)
        with self._lock:
            self._seq += 1
            request_id = self._seq
            box: "queue.Queue" = queue.Queue(maxsize=1)
            self._pending[request_id] = box
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        try:
            assert self._proc.stdin is not None
            self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()
        except (OSError, ValueError) as error:
            with self._lock:
                self._pending.pop(request_id, None)
            raise BridgeError("E_DISCONNECTED", f"MCP 写入失败：{error}") from error
        if on_start is not None:
            try:
                on_start(request_id)
            except Exception:
                with self._lock:
                    self._pending.pop(request_id, None)
                raise
        try:
            message = box.get(timeout=wait)
        except queue.Empty:
            with self._lock:
                self._pending.pop(request_id, None)
            self._abort()
            raise BridgeError("E_TIMEOUT", f"MCP {method} 超过 {wait:.2f}s 未返回") from None
        if message is None:
            raise BridgeError("E_DISCONNECTED", "MCP server 已退出")
        if isinstance(message, dict) and message.get("_cancelled"):
            reason = str(message.get("reason") or "")
            raise BridgeError(
                "E_CANCELLED",
                f"MCP {method} 已被取消" + (f"：{reason}" if reason else ""),
                data={"requestId": request_id, "reason": reason},
            )
        if message.get("error") is not None:
            error = message["error"] if isinstance(message["error"], dict) else {"message": str(message["error"])}
            raise BridgeError("E_RPC", str(error.get("message") or "mcp rpc failed"), data=error)
        return message.get("result")

    def _abort(self) -> None:
        self._closed = True
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass

    def close(self) -> None:
        self._closed = True
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            if proc.stdout is not None:
                proc.stdout.close()
        except (OSError, ValueError):
            pass
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass


def _payload_from_tool_result(name: str, result: Any) -> Any:
    """把 MCP tools/call result 还原成工具原始返回值；isError 时抛 ToolCallError。"""
    if not isinstance(result, dict):
        return result
    content = result.get("content") or []
    texts = [
        str(item.get("text") or "")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    text = "\n".join(piece for piece in texts if piece)
    meta = result.get("_meta") or {}
    if result.get("isError") is True:
        code = meta.get("browser-bridge/errorCode")
        if not code:
            match = re.match(r"\s*([A-Z][A-Z0-9_]+)\s*[:：]", text)
            code = match.group(1) if match else "E_INTERNAL"
        details: Any = meta.get("browser-bridge/validation")
        if details is None:
            details = dict(meta) if meta else None
        raise ToolCallError(str(code), text, tool=name, details=details)
    try:
        return json.loads(text)
    except ValueError:
        return text


class McpToolClient:
    """MCP 工具级客户端：92 工具调用 + 入参校验 + 审批/超时 + 分页续读 + prompts/resources。

    用法::

        client = McpToolClient(home="~/.browser-bridge").connect()
        client.call_tool("browser_status", {})
        client.call_tool("browser_evaluate", {"expression": "1+1"}, approval=True)
        client.call_tool("browser_observe", {}, progress=True, on_progress=print)
        client.call_tool("browser_observe", {}, on_request=lambda rid: client.cancel_request(rid))
        client.call_tool_paged("browser_observe", {}, max_pages=3)
        client.read_resource("bridge://protocol/summary?limit=512")
        client.get_prompt("har_analysis", {"source": "latest"})
        client.close()

    也可以通过 ``transport=`` 注入自定义传输（单测不需要 node/浏览器）。
    """

    def __init__(self, home: Optional[Union[str, Path]] = None, timeout: float = DEFAULT_TIMEOUT,
                 node: Optional[str] = None, transport: Any = None):
        self.home = Path(home).expanduser() if home else default_home()
        self.timeout = float(timeout)
        self.node = node or os.environ.get("BB_NODE") or shutil.which("node")
        self._transport = transport
        self.server_info: Optional[Dict[str, Any]] = None
        self.capabilities: Dict[str, Any] = {}
        self.connected = False
        self._closed = False
        # 本地订阅记录（W7-C）：server 的订阅集合是本连接级；这里只是给调用方一个可查询的镜像。
        self.subscriptions: set = set()
        self._resource_handlers: List[Any] = []

    # -- 传输 ---------------------------------------------------------------
    @property
    def transport(self) -> Any:
        if self._closed:
            raise BridgeError("E_DISCONNECTED", "MCP 工具客户端已关闭：先调用 connect() 重新握手")
        if self._transport is None:
            if not self.node:
                raise BridgeError("E_ENV", "找不到 node：设置 BB_NODE 或把 node 加进 PATH（Python SDK 的工具级调用需要本机 node）")
            if not MCP_SERVER_PATH.exists():
                raise BridgeError("E_ENV", f"找不到 MCP server：{MCP_SERVER_PATH}")
            env = dict(os.environ)
            env["BB_HOME"] = str(self.home)
            self._transport = StdioMcpTransport(
                [str(self.node), str(MCP_SERVER_PATH)],
                cwd=str(REPO_ROOT),
                env=env,
                timeout=self.timeout,
            )
        return self._transport

    def connect(self) -> "McpToolClient":
        """initialize 握手；重复调用是幂等的。"""
        if self.connected:
            return self
        self._closed = False
        result = self.transport.request("initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "browser-bridge-python-sdk", "version": "0.1.2"},
        }, timeout=self.timeout)
        if isinstance(result, dict):
            self.server_info = result.get("serverInfo") or {}
            self.capabilities = result.get("capabilities") or {}
        try:
            self.transport.notify("notifications/initialized", {})
        except BridgeError:
            pass
        self.connected = True
        return self

    def close(self) -> None:
        transport = self._transport
        self._transport = None
        self.connected = False
        self._closed = True
        # 断开清理：本地订阅镜像与通知回调都不跨连接（server 侧同样在断开时清空订阅）。
        self.subscriptions.clear()
        self._resource_handlers.clear()
        if transport is not None:
            transport.close()

    def __enter__(self) -> "McpToolClient":
        return self.connect()

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    # -- MCP 方法 -----------------------------------------------------------
    def list_mcp_tools(self) -> List[Dict[str, Any]]:
        result = self.transport.request("tools/list", {}, timeout=self.timeout)
        return list((result or {}).get("tools") or [])

    def list_prompts(self) -> List[Dict[str, Any]]:
        result = self.transport.request("prompts/list", {}, timeout=self.timeout)
        return list((result or {}).get("prompts") or [])

    def get_prompt(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        result = self.transport.request(
            "prompts/get",
            {"name": str(name), "arguments": arguments or {}},
            timeout=self.timeout,
        )
        return result or {}

    def list_resources(self) -> List[Dict[str, Any]]:
        result = self.transport.request("resources/list", {}, timeout=self.timeout)
        return list((result or {}).get("resources") or [])

    def read_resource(self, uri: str) -> Dict[str, Any]:
        result = self.transport.request("resources/read", {"uri": str(uri)}, timeout=self.timeout)
        return result or {}

    # -- 资源订阅（W7-C：与 MCP resources/subscribe 对齐）--------------------
    def subscribe_resource(self, uri: str) -> Dict[str, Any]:
        """订阅资源变更（resources/subscribe），返回 server 的订阅报告。

        订阅是 URI 级精确匹配：快照更新时 server 推送 ``notifications/resources/updated``，
        用 :meth:`add_resource_updated_handler` 接收。订阅只在本次连接内有效（断开即清理）。
        """
        key = str(uri)
        result = self.transport.request("resources/subscribe", {"uri": key}, timeout=self.timeout)
        self.subscriptions.add(key)
        return self._subscription_report(result)

    def unsubscribe_resource(self, uri: str) -> Dict[str, Any]:
        """取消订阅（幂等；未订阅过也返回成功，报告的 found 字段说明是否真的移除过）。"""
        key = str(uri)
        result = self.transport.request("resources/unsubscribe", {"uri": key}, timeout=self.timeout)
        self.subscriptions.discard(key)
        return self._subscription_report(result)

    def resource_subscriptions(self) -> List[str]:
        """本地记录的已订阅 URI（按字典序；仅代表本连接）。"""
        return sorted(self.subscriptions)

    def supports_resource_subscriptions(self) -> bool:
        """server 是否声明 resources.subscribe=true（旧 server 会返回 False）。"""
        return bool((self.capabilities.get("resources") or {}).get("subscribe"))

    def add_resource_updated_handler(self, handler: Any) -> Any:
        """注册 resources/updated 回调：``handler(params)``，params 形如 ``{"uri": ..., "_meta": {...}}``。

        返回同一 handler（传给 :meth:`remove_resource_updated_handler` 注销）；传输不支持
        server→client 通知时抛 ``E_UNSUPPORTED_CAPABILITY``，不静默丢弃回调。
        """
        if not callable(handler):
            raise BridgeError("E_ARG_TYPE", "资源更新回调必须可调用")
        add = getattr(self.transport, "add_notification_handler", None)
        if not callable(add):
            raise BridgeError("E_UNSUPPORTED_CAPABILITY", "当前传输不支持 server→client 通知回调")

        def _listener(message: Any) -> None:
            if not isinstance(message, dict) or message.get("method") != "notifications/resources/updated":
                return
            params = message.get("params")
            self._dispatch_resource_updated(handler, dict(params) if isinstance(params, dict) else {})

        add(_listener)
        self._resource_handlers.append(_listener)
        return _listener

    def remove_resource_updated_handler(self, handler: Any) -> bool:
        """注销资源更新回调；返回是否真的移除。"""
        remove = getattr(self.transport, "remove_notification_handler", None)
        removed = bool(remove(handler)) if callable(remove) else False
        if removed and handler in self._resource_handlers:
            self._resource_handlers.remove(handler)
        return removed

    @staticmethod
    def _subscription_report(result: Any) -> Dict[str, Any]:
        if not isinstance(result, dict):
            return {}
        meta = result.get("_meta")
        if not isinstance(meta, dict):
            return {}
        report = meta.get("browser-bridge/subscription")
        return dict(report) if isinstance(report, dict) else {}

    @staticmethod
    def _dispatch_resource_updated(handler: Any, params: Dict[str, Any]) -> None:
        try:
            handler(params)
        except Exception:  # noqa: BLE001 - 回调失败不能影响读线程/其他订阅者
            pass

    # -- 工具调用 -----------------------------------------------------------
    def call_tool(self, name: str, args: Optional[Dict[str, Any]] = None,
                  approval: bool = False, timeout: Optional[float] = None,
                  on_progress: Optional[Any] = None, validate: bool = True,
                  progress: Optional[bool] = None,
                  on_request: Optional[Any] = None,
                  cancel_scope: Optional[Any] = None,
                  retry: Optional[Union[bool, int]] = None) -> Any:
        """调用一个 MCP 工具，返回工具原始结果。

        - 本地先按同一份 schema 校验（E_ARG_MISSING/TYPE/ENUM/RANGE/UNEXPECTED）；
        - destructive/sensitive 工具需要 approval=True（BB_MCP_APPROVAL=off 可关闭，
          但 browser_update 恒需要确认）；
        - timeout 默认取工具策略 timeout_ms；超时抛 E_TIMEOUT；
        - on_progress(event) 收到本地阶段 {phase: start|progress|done|error|cancelled, tool,
          tier, elapsed_ms, cursor}（best-effort）。progress=True 时额外在
          params._meta.progressToken 里带令牌，并把 server 的 notifications/progress
          转成 phase="progress" 事件（含 progress/total/message）；
        - on_request(request_id) 在请求写出后回调，可结合 ``cancel_request()`` 从其他线程取消；
          被取消时抛 E_CANCELLED（本地进度补一条 phase="cancelled"）；
        - cancel_scope（CancellationScope）：把它交给调用线程之外的取消者，
          scope.cancel() 会通过 on_request 登记的 request_id 转发取消；
        - retry=True/整数：按 mcp/error-map 的重试建议做指数退避（见 call_tool_with_retry）。
        """
        if retry:
            attempts = RETRY_POLICY["max_attempts"] if retry is True else int(retry)
            return self.call_tool_with_retry(
                name, args, max_attempts=attempts, approval=approval, timeout=timeout,
                on_progress=on_progress, validate=validate, progress=progress,
                on_request=on_request, cancel_scope=cancel_scope,
            )
        return self._invoke_tool(
            name, args, approval=approval, timeout=timeout, on_progress=on_progress,
            validate=validate, progress=progress, on_request=on_request,
            cancel_scope=cancel_scope,
        )["payload"]

    def call_tool_detailed(self, name: str, args: Optional[Dict[str, Any]] = None,
                           approval: bool = False, timeout: Optional[float] = None,
                           on_progress: Optional[Any] = None, validate: bool = True,
                           progress: Optional[bool] = None,
                           on_request: Optional[Any] = None,
                           cancel_scope: Optional[Any] = None) -> Dict[str, Any]:
        """同 call_tool，但返回全部元信息：payload/meta/elapsed_ms/request_id/events。"""
        return self._invoke_tool(
            name, args, approval=approval, timeout=timeout, on_progress=on_progress,
            validate=validate, progress=progress, on_request=on_request,
            cancel_scope=cancel_scope,
        )

    def _invoke_tool(self, name: str, args: Optional[Dict[str, Any]] = None,
                     approval: bool = False, timeout: Optional[float] = None,
                     on_progress: Optional[Any] = None, validate: bool = True,
                     progress: Optional[bool] = None,
                     on_request: Optional[Any] = None,
                     cancel_scope: Optional[Any] = None) -> Dict[str, Any]:
        """单次工具调用的实现（call_tool / call_tool_detailed 共用）。"""
        spec = tool_spec(name)
        if spec is None:
            raise ToolCallError("E_ARG_UNEXPECTED", f"未知 MCP 工具：{name}", tool=str(name))
        if validate:
            assert_tool_args(name, args)
        bag = dict(args or {})
        if spec["approval_required"] and not approval:
            if spec["approval_always"] or not _approval_disabled():
                raise ToolCallError(
                    "E_HUMAN_GATE",
                    f"{name} 属于 {spec['tier']} 级工具，需要人工确认：用 approval=True 重试。",
                    tool=name,
                    details={"tier": spec["tier"], "approval_required": True},
                )
        wait = float(timeout) if timeout else spec["timeout_ms"] / 1000.0
        started = time.monotonic()
        events: List[Dict[str, Any]] = []
        request_id: Dict[str, Any] = {"id": None}

        def _emit(event: Dict[str, Any]) -> None:
            events.append(dict(event))
            self._progress(on_progress, event)

        progress_token = self._new_progress_token() if progress else None
        progress_handler: Optional[Any] = None
        transport = self.transport
        if progress_token is not None:
            add_handler = getattr(transport, "add_notification_handler", None)
            if callable(add_handler) and on_progress is not None:
                def _on_progress_notification(message: Any) -> None:
                    if not isinstance(message, dict) or message.get("method") != "notifications/progress":
                        return
                    params = message.get("params") or {}
                    if params.get("progressToken") != progress_token:
                        return
                    _emit({
                        "phase": "progress",
                        "tool": name,
                        "tier": spec["tier"],
                        "progress": params.get("progress"),
                        "total": params.get("total"),
                        "message": params.get("message"),
                        "elapsed_ms": self._elapsed_ms(started),
                    })

                add_handler(_on_progress_notification)
                progress_handler = _on_progress_notification
        try:
            _emit({"phase": "start", "tool": name, "tier": spec["tier"], "elapsed_ms": 0.0, "cursor": bag.get("cursor")})
            params: Dict[str, Any] = {"name": name, "arguments": bag}
            meta: Dict[str, Any] = {}
            if approval:
                meta[APPROVAL_META_KEY] = APPROVAL_CONFIRMED
            if progress_token is not None:
                meta["progressToken"] = progress_token
            if meta:
                params["_meta"] = meta
            request_options: Dict[str, Any] = {"timeout": wait}

            def _on_start(rid: int) -> None:
                request_id["id"] = rid
                if cancel_scope is not None:
                    try:
                        cancel_scope.attach(rid, self.cancel_request)
                    except Exception:  # noqa: BLE001 - 取消登记失败不应阻断调用
                        pass
                if on_request is not None:
                    on_request(rid)

            # 只有确实需要 request_id 回调时才传 on_start：保持对旧自定义传输（fake）的兼容，
            # 它们可能只接受 (method, params, timeout) 三个参数。
            if on_request is not None or cancel_scope is not None:
                request_options["on_start"] = _on_start
            try:
                result = transport.request("tools/call", params, **request_options)
            except BridgeError as error:
                if error.code == "E_CANCELLED":
                    _emit({"phase": "cancelled", "tool": name, "tier": spec["tier"], "elapsed_ms": self._elapsed_ms(started), "code": error.code})
                else:
                    _emit({"phase": "error", "tool": name, "tier": spec["tier"], "elapsed_ms": self._elapsed_ms(started), "code": error.code})
                raise
            result_meta = result.get("_meta") if isinstance(result, dict) else None
            try:
                payload = _payload_from_tool_result(name, result)
            except ToolCallError as error:
                _emit({"phase": "error", "tool": name, "tier": spec["tier"], "elapsed_ms": self._elapsed_ms(started), "code": error.code})
                raise
            elapsed = self._elapsed_ms(started)
            _emit({"phase": "done", "tool": name, "tier": spec["tier"], "elapsed_ms": elapsed, "cursor": bag.get("cursor")})
            return {
                "payload": payload,
                "meta": dict(result_meta) if isinstance(result_meta, dict) else {},
                "elapsed_ms": elapsed,
                "request_id": request_id["id"],
                "events": events,
                "tool": name,
                "tier": spec["tier"],
            }
        finally:
            if progress_handler is not None:
                remove_handler = getattr(transport, "remove_notification_handler", None)
                if callable(remove_handler):
                    remove_handler(progress_handler)
                progress_handler = None

    def cancel_request(self, request_id: int, reason: str = "") -> bool:
        """取消一个在途工具调用（on_request 拿到的 id）；transport 不支持时返回 False。"""
        transport = self.transport
        cancel = getattr(transport, "cancel", None)
        if not callable(cancel):
            return False
        return bool(cancel(request_id, reason))

    def call_tool_paged(self, name: str, args: Optional[Dict[str, Any]] = None, max_pages: int = DEFAULT_PAGE_LIMIT,
                        approval: bool = False, timeout: Optional[float] = None,
                        on_progress: Optional[Any] = None,
                        progress: Optional[bool] = None,
                        on_request: Optional[Any] = None,
                        cancel_scope: Optional[Any] = None,
                        retry: Optional[Union[bool, int]] = None) -> List[Any]:
        """对分页工具按 nextCursor 续读，返回每页结果列表（非分页工具返回单元素列表）。"""
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        markers = pagination_markers(name)
        pages: List[Any] = []
        current = dict(args or {})
        while len(pages) < max_pages:
            page = self.call_tool(
                name, current,
                approval=approval, timeout=timeout, on_progress=on_progress,
                progress=progress, on_request=on_request,
                cancel_scope=cancel_scope, retry=retry,
            )
            pages.append(page)
            if not markers["partial"]:
                break
            continuation = next_page_params(name, page)
            if not continuation:
                break
            current.update(continuation)
        return pages

    @staticmethod
    def _new_progress_token() -> str:
        """生成本次调用的进度令牌（string，≤128 字符）。"""
        return "bb-" + str(os.getpid()) + "-" + uuid.uuid4().hex[:12]

    @staticmethod
    def _elapsed_ms(started: float) -> float:
        return round((time.monotonic() - started) * 1000.0, 1)

    @staticmethod
    def _progress(callback: Optional[Any], event: Dict[str, Any]) -> None:
        if callback is None:
            return
        try:
            callback(dict(event))
        except Exception:  # noqa: BLE001 - 进度回调失败不应中断工具调用
            pass

    # -- 第十批-B：重试 / 分页迭代 / 并发 / 补全 ---------------------------------
    def call_tool_with_retry(self, name: str, args: Optional[Dict[str, Any]] = None,
                             max_attempts: Optional[int] = None,
                             on_retry: Optional[Any] = None,
                             **options: Any) -> Any:
        """按 mcp/error-map.mjs 的同一套重试建议做指数退避调用。

        判定：只有 retry_plan(code).retryable 的错误才重试（E_ARG_* / E_HUMAN_GATE /
        E_CANCELLED / E_DAEMON 等一律不重试）；延迟与抖动算法与 Node 侧
        retryDelayMs 逐位一致，三方契约测试直接对比数值。
        """
        attempts = int(max_attempts or RETRY_POLICY["max_attempts"])
        if attempts < 1:
            raise BridgeError("E_ARG_RANGE", f"max_attempts 必须是正整数，实际 {attempts!r}")
        attempt = 1
        while True:
            try:
                return self.call_tool(name, args, **options)
            except (BridgeError, ToolCallError) as error:
                plan = retry_plan(getattr(error, "code", ""), attempt=attempt, max_attempts=attempts)
                if not plan["retryable"]:
                    raise
                attempt += 1
                if on_retry is not None:
                    try:
                        on_retry(dict(plan, tool=name))
                    except Exception:  # noqa: BLE001 - 重试回调失败不应中断重试
                        pass
                if plan["delay_ms"] > 0:
                    time.sleep(plan["delay_ms"] / 1000.0)

    def iter_tool_pages(self, name: str, args: Optional[Dict[str, Any]] = None,
                        max_pages: int = DEFAULT_PAGE_LIMIT, **options: Any) -> Any:
        """生成器版分页：每产出一页前先请求；用尽/不再续读时停止（可不取全量）。"""
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        markers = pagination_markers(name)
        current = dict(args or {})
        produced = 0
        while produced < max_pages:
            page = self.call_tool(name, current, **options)
            produced += 1
            yield page
            if not markers["partial"]:
                return
            continuation = next_page_params(name, page)
            if not continuation:
                return
            current.update(continuation)

    def call_tools(self, calls: Iterable[Any], max_workers: int = 4,
                   **options: Any) -> List[Dict[str, Any]]:
        """并发调用多个工具（同一连接；stdio 传输按请求 id 分发，线程安全）。

        calls 形如 [("browser_status", {}), ("browser_observe", {"max_tokens": 800})]
        或 [{"name": ..., "args": {...}, "approval": True}, ...]。
        返回按输入顺序排列的 [{ok, name, result|error, code}]；单个失败不影响其它调用。
        """
        from concurrent.futures import ThreadPoolExecutor  # 延迟导入：不增加模块加载成本

        normalized: List[Dict[str, Any]] = []
        for item in calls:
            if isinstance(item, dict):
                normalized.append({"name": str(item.get("name")), "args": item.get("args") or {}, "options": {k: v for k, v in item.items() if k not in ("name", "args")}})
            else:
                name, args = item[0], (item[1] if len(item) > 1 else {})
                normalized.append({"name": str(name), "args": args or {}, "options": {}})
        workers = max(1, min(int(max_workers), len(normalized) or 1))

        def _run(row: Dict[str, Any]) -> Dict[str, Any]:
            merged = dict(options)
            merged.update(row["options"])
            try:
                return {"ok": True, "name": row["name"], "result": self.call_tool(row["name"], row["args"], **merged)}
            except (BridgeError, ToolCallError) as error:
                return {"ok": False, "name": row["name"], "code": getattr(error, "code", "E_INTERNAL"), "error": str(error)}

        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(_run, normalized))

    def list_resources_all(self, max_pages: int = 20, page_size: int = 100) -> Dict[str, Any]:
        """resources/list 全量拉取（按 nextCursor 续读，默认每页 100 行）。"""
        resources: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        pages = 0
        while pages < max_pages:
            params: Dict[str, Any] = {}
            if cursor:
                params["cursor"] = cursor
            if page_size:
                params["limit"] = page_size
            result = self.transport.request("resources/list", params, timeout=self.timeout) or {}
            resources.extend(result.get("resources") or [])
            pages += 1
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return {"resources": resources, "pages": pages, "next_cursor": cursor}

    def list_prompts_all(self, max_pages: int = 10, page_size: int = 100) -> Dict[str, Any]:
        """prompts/list 全量拉取（服务端同样支持 limit/cursor）。"""
        prompts: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        pages = 0
        while pages < max_pages:
            params: Dict[str, Any] = {}
            if cursor:
                params["cursor"] = cursor
            if page_size:
                params["limit"] = page_size
            result = self.transport.request("prompts/list", params, timeout=self.timeout) or {}
            prompts.extend(result.get("prompts") or [])
            pages += 1
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return {"prompts": prompts, "pages": pages, "next_cursor": cursor}

    def complete(self, ref: Dict[str, Any], argument: Dict[str, Any],
                 cursor: Optional[str] = None, limit: Optional[int] = None,
                 context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """completion/complete：prompt 参数 / 资源模板变量候选值。"""
        params: Dict[str, Any] = {"ref": ref, "argument": argument}
        if cursor:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = limit
        if context is not None:
            params["context"] = context
        return self.transport.request("completion/complete", params, timeout=self.timeout) or {}

    def complete_prompt_argument(self, prompt: str, argument: str, value: str = "",
                                 limit: Optional[int] = None) -> Dict[str, Any]:
        """便捷封装：补全某个 prompt 参数（返回 completion.values 等）。"""
        result = self.complete({"type": "ref/prompt", "name": str(prompt)}, {"name": str(argument), "value": value}, limit=limit)
        return dict(result.get("completion") or {})

    def complete_resource_argument(self, uri_template: str, argument: str, value: str = "",
                                   limit: Optional[int] = None) -> Dict[str, Any]:
        """便捷封装：补全某个资源模板变量（返回 completion.values 等）。"""
        result = self.complete({"type": "ref/resource", "uri": str(uri_template)}, {"name": str(argument), "value": value}, limit=limit)
        return dict(result.get("completion") or {})

    def supports_completion(self) -> bool:
        """server 是否声明 completion 能力（旧 server 返回 False）。"""
        return "completions" in self.capabilities

    def supports_list_pagination(self) -> bool:
        """resources 是否声明了行级分页能力（listPagination）。"""
        resources = self.capabilities.get("resources") or {}
        return bool(resources.get("listPagination"))

    def tool_coverage(self) -> Dict[str, Any]:
        """92 工具覆盖审计（转发到模块级 tool_coverage；见文末“全部 MCP 工具覆盖审计”）。"""
        return tool_coverage()


def default_home() -> Path:
    configured = os.environ.get("BB_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".browser-bridge"


def daemon_info_path(home: Optional[Union[str, Path]] = None) -> Path:
    return Path(home).expanduser() / "daemon.json" if home else default_home() / "daemon.json"


def read_daemon_info(home: Optional[Union[str, Path]] = None) -> Optional[Dict[str, Any]]:
    try:
        info = json.loads(daemon_info_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(info, dict) and isinstance(info.get("port"), int) and isinstance(info.get("token"), str):
        return info
    return None


def _request_json(info: Dict[str, Any], path: str, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{info['port']}{path}",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-bridge-token": str(info.get("token", "")),
        },
    )
    if info.get("tls") is True:
        request.full_url = f"https://127.0.0.1:{info['port']}{path}"
    context = ssl._create_unverified_context() if info.get("tls") is True else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise BridgeError("E_DAEMON", f"daemon HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise BridgeError("E_DAEMON", f"连接 daemon 失败：{error}") from error


def _health_ok(info: Dict[str, Any]) -> bool:
    url = f"{'https' if info.get('tls') is True else 'http'}://127.0.0.1:{info['port']}/health"
    context = ssl._create_unverified_context() if info.get("tls") is True else None
    try:
        with urllib.request.urlopen(url, timeout=0.8, context=context) as response:
            return response.status == 200
    except Exception:
        return False


def start_daemon(home: Optional[Union[str, Path]] = None, timeout: float = START_TIMEOUT) -> Dict[str, Any]:
    """没有 daemon 时用当前 Python 环境能找到的 node 拉起 workspace daemon。"""
    home_path = Path(home).expanduser() if home else default_home()
    server = REPO_ROOT / "daemon" / "server.mjs"
    if not server.exists():
        raise BridgeError("E_DAEMON", f"找不到 daemon/server.mjs：{server}")
    node = os.environ.get("BB_NODE") or "node"
    env = dict(os.environ)
    env["BB_HOME"] = str(home_path)
    try:
        subprocess.Popen(
            [node, str(server), "--foreground"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        raise BridgeError("E_DAEMON", f"拉起 daemon 失败（需要 node 在 PATH 或 BB_NODE）：{error}") from error
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.15)
        info = read_daemon_info(home_path)
        if info and _health_ok(info):
            return info
    raise BridgeError("E_DAEMON", f"daemon 在 {timeout:.0f}s 内未就绪；先运行 bridge status 查看日志")


def target_params(target: Union[str, Dict[str, Any]]) -> Dict[str, str]:
    if isinstance(target, dict):
        if target.get("ref"):
            return {"ref": str(target["ref"])}
        if target.get("selector"):
            return {"selector": str(target["selector"])}
        raise BridgeError("E_BAD_ARG", "target 需要 ref 或 selector")
    text = str(target or "")
    if not text:
        raise BridgeError("E_BAD_ARG", "缺少 target（@ref 或 CSS selector）")
    return {"ref": text} if text.startswith("@") else {"selector": text}


class Page:
    """一个浏览器会话（≈ Playwright 的 Page）。所有方法自动带 session。"""

    def __init__(self, bridge: "BrowserBridge", info: Dict[str, Any]):
        self.bridge = bridge
        self.id = info["sessionId"]
        self.tab_id = info.get("tabId")
        self.window_id = info.get("windowId")
        self.instance_id = info.get("instanceId")

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        merged = {"session": self.id}
        merged.update(params or {})
        return self.bridge.rpc(method, merged, timeout=timeout)

    def goto(self, url: str, **options: Any) -> Any:
        return self.call("navigate", {"url": str(url), **options})

    def reload(self, **options: Any) -> Any:
        return self.call("reload", options)

    def back(self, **options: Any) -> Any:
        return self.call("navigate-back", options)

    def forward(self, **options: Any) -> Any:
        return self.call("navigate-forward", options)

    def click(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("click", {**target_params(target), **options})

    def click_backend(self, backend_node_id: int, **options: Any) -> Any:
        """按 backendNodeId 点击没有 @eN ref 的元素（closed shadow 等）。"""
        return self.call("click-backend", {"backendId": int(backend_node_id), **options})

    def hover(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("hover", {**target_params(target), **options})

    def fill(self, target: Union[str, Dict[str, Any]], value: str, **options: Any) -> Any:
        return self.call("fill", {**target_params(target), "value": str(value), **options})

    def press(self, key: str, target: Optional[Union[str, Dict[str, Any]]] = None, **options: Any) -> Any:
        params: Dict[str, Any] = {"key": str(key), **options}
        if target is not None:
            params.update(target_params(target))
        return self.call("press", params)

    def select(self, target: Union[str, Dict[str, Any]], value: str, **options: Any) -> Any:
        return self.call("select", {**target_params(target), "value": str(value), **options})

    def evaluate(self, expression: str) -> Any:
        return self.call("evaluate", {"expression": str(expression)})

    def observe(self, **options: Any) -> Any:
        return self.call("observe", options)

    def snapshot(self) -> Any:
        return self.call("snapshot", {})

    def wait_for_element(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("wait-for-element", {**target_params(target), **options})

    def wait_for_navigation(self, **options: Any) -> Any:
        return self.call("wait-for-navigation", options)

    def screenshot(self, path: Optional[Union[str, Path]] = None, **options: Any) -> Any:
        result = self.call("screenshot", options)
        if path and isinstance(result, dict) and isinstance(result.get("dataUrl"), str):
            data = result["dataUrl"].split(",", 1)[-1]
            output = Path(path).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(base64.b64decode(data))
        return result

    def call_tool(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> Any:
        """在会话上下文里调用 MCP 工具：schema 声明了 session 且未显式给出时自动补。"""
        spec = tool_spec(name)
        if spec is None:
            raise ToolCallError("E_ARG_UNEXPECTED", f"未知 MCP 工具：{name}", tool=str(name))
        merged = dict(args or {})
        if "session" not in merged and any(prop_name == "session" for prop_name, _definition in spec["props"]):
            merged["session"] = self.id
        return self.bridge.call_tool(name, merged, **options)

    def call_tool_paged(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> List[Any]:
        """在会话上下文里分页调用 MCP 工具（自动补 session + 按 cursor 续读）。"""
        spec = tool_spec(name)
        if spec is None:
            raise ToolCallError("E_ARG_UNEXPECTED", f"未知 MCP 工具：{name}", tool=str(name))
        merged = dict(args or {})
        if "session" not in merged and any(prop_name == "session" for prop_name, _definition in spec["props"]):
            merged["session"] = self.id
        return self.bridge.call_tool_paged(name, merged, **options)

    def pause(self, reason: str = "python-sdk") -> Any:
        return self.call("session.pause", {"paused": True, "reason": reason})

    def resume(self) -> Any:
        return self.call("session.pause", {"paused": False})

    def close(self, keep: bool = False) -> Any:
        return self.bridge.rpc("session.stop", {"session": self.id, "keep": bool(keep)})


class BrowserBridge:
    """daemon 连接（≈ Playwright 的 Browser）。"""

    def __init__(
        self,
        info: Dict[str, Any],
        home: Optional[Union[str, Path]] = None,
        timeout: float = DEFAULT_TIMEOUT,
        protocol: Optional[str] = None,
        enforce_features: bool = False,
    ):
        self.info = {"port": int(info["port"]), "token": str(info["token"]), "tls": info.get("tls") is True}
        self.home = Path(home).expanduser() if home else default_home()
        self.timeout = float(timeout)
        # 对端协议版本用于本地能力门禁；daemon.json 带 protocol 时自动采用。
        self.protocol = str(protocol or info.get("protocol") or "") or None
        self.enforce_features = bool(enforce_features)
        # 工具级调用面按需创建 MCP 客户端（只做 RPC 的调用方不付这个成本）。
        self._tool_client: Optional[McpToolClient] = None

    @classmethod
    def connect(
        cls,
        home: Optional[Union[str, Path]] = None,
        timeout: float = DEFAULT_TIMEOUT,
        auto_start: bool = True,
        start_timeout: float = START_TIMEOUT,
        protocol: Optional[str] = None,
        enforce_features: bool = False,
    ) -> "BrowserBridge":
        home_path = Path(home).expanduser() if home else default_home()
        info = read_daemon_info(home_path)
        if not info:
            if not auto_start:
                raise BridgeError("E_DAEMON", f"daemon 未运行，且 auto_start=False：{daemon_info_path(home_path)}")
            info = start_daemon(home_path, timeout=start_timeout)
        return cls(info, home=home_path, timeout=timeout, protocol=protocol, enforce_features=enforce_features)

    def rpc(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        if self.enforce_features:
            decision = protocol_gate(self.protocol, method, params)
            if not decision["ok"]:
                raise BridgeError(
                    decision["code"],
                    f"{method} 需要协议 floor {decision['required_floor']}，对端协议 {self.protocol or '未知'}",
                    data=decision,
                    method=method,
                )
        payload = {"method": method, "params": params or {}, "timeoutMs": int((timeout or self.timeout) * 1000)}
        body = _request_json(self.info, "/rpc", payload, (timeout or self.timeout) + 1.0)
        if body.get("ok") is not True:
            error = body.get("error") or {}
            raise BridgeError(
                str(error.get("code") or "E_INTERNAL"),
                str(error.get("message") or "rpc failed"),
                data=error.get("data"),
                method=method,
            )
        return body.get("result")

    def protocol_gate(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """本地能力门禁（不抛异常），便于调用方先判断再决定是否调用。"""
        return protocol_gate(self.protocol, method, params)

    def pagination(self, tool: str) -> Dict[str, Any]:
        """MCP 工具的分页标记。"""
        return pagination_markers(tool)

    def next_page(self, tool: str, result: Any) -> Dict[str, Any]:
        """从工具结果提取续读参数（无下一页时为空 dict）。"""
        return next_page_params(tool, result)

    # -- 工具级调用面（92 个 MCP 工具）-------------------------------------
    def tools(self) -> List[Dict[str, Any]]:
        """92 个 MCP 工具目录（与 Node SDK / MCP tools/list 同源生成）。"""
        return list_tools()

    def tool_spec(self, name: str) -> Optional[Dict[str, Any]]:
        """单工具目录；未知工具返回 None。"""
        return tool_spec(name)

    def validate_tool_args(self, name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """工具入参校验（E_ARG_* 分类，与 MCP server 一致）。"""
        return validate_tool_args(name, args)

    def tool_tier_summary(self) -> Dict[str, Any]:
        """分档统计（read/mutate/destructive、审批清单、分页工具）。"""
        return tool_tier_summary()

    def tool_client(self, **options: Any) -> McpToolClient:
        """惰性创建 MCP 工具客户端（首次调用时拉起 `node mcp/server.mjs`）。"""
        if self._tool_client is None:
            options.setdefault("home", self.home)
            options.setdefault("timeout", self.timeout)
            self._tool_client = McpToolClient(**options)
        return self._tool_client

    def call_tool(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> Any:
        """调用任意 MCP 工具（参数校验/审批/超时/错误 data，见 McpToolClient.call_tool）。"""
        return self.tool_client().connect().call_tool(name, args, **options)

    def call_tool_paged(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> List[Any]:
        """分页调用：按 cursor 自动续读，返回每页结果列表。"""
        return self.tool_client().connect().call_tool_paged(name, args, **options)

    def close_tools(self) -> Dict[str, Any]:
        """关闭工具客户端（结束 MCP 子进程），幂等。"""
        client = self._tool_client
        self._tool_client = None
        if client is None:
            return {"ok": True, "closed": False}
        client.close()
        return {"ok": True, "closed": True}

    # -- 资源订阅（W7-C）---------------------------------------------------
    def subscribe_resource(self, uri: str) -> Dict[str, Any]:
        """订阅资源变更（懒创建 MCP 工具客户端；订阅随连接断开清理）。"""
        return self.tool_client().connect().subscribe_resource(uri)

    def unsubscribe_resource(self, uri: str) -> Dict[str, Any]:
        """取消资源订阅（幂等）。"""
        return self.tool_client().connect().unsubscribe_resource(uri)

    def resource_subscriptions(self) -> List[str]:
        """本地记录的已订阅 URI；尚未创建工具客户端时为空。"""
        client = self._tool_client
        return [] if client is None else client.resource_subscriptions()

    def supports_resource_subscriptions(self) -> bool:
        """server 是否支持资源订阅（读 initialize 的 capabilities.resources.subscribe）。"""
        return self.tool_client().connect().supports_resource_subscriptions()

    def add_resource_updated_handler(self, handler: Any) -> Any:
        """注册 resources/updated 回调（见 McpToolClient.add_resource_updated_handler）。"""
        return self.tool_client().connect().add_resource_updated_handler(handler)

    def remove_resource_updated_handler(self, handler: Any) -> bool:
        """注销资源更新回调。"""
        return self.tool_client().connect().remove_resource_updated_handler(handler)

    def status(self) -> Any:
        return self.rpc("status")

    def sessions(self) -> List[Dict[str, Any]]:
        return list((self.rpc("session.list") or {}).get("sessions") or [])

    def browsers(self) -> List[Dict[str, Any]]:
        return list((self.rpc("browsers") or {}).get("browsers") or [])

    def new_page(
        self,
        url: Optional[str] = None,
        browser: Optional[str] = None,
        tab: Optional[int] = None,
        no_focus: bool = False,
        incognito: bool = False,
    ) -> Page:
        params: Dict[str, Any] = {}
        if browser:
            params["browser"] = str(browser)
        if tab is not None:
            params["tab"] = int(tab)
        if no_focus:
            params["noFocus"] = True
        if incognito:
            params["incognito"] = True
        info = self.rpc("session.start", params)
        page = Page(self, info)
        if url:
            page.goto(url)
        return page

    def page(self, session_id: str) -> Page:
        for item in self.sessions():
            if item.get("sessionId") == str(session_id):
                return Page(self, item)
        raise BridgeError("E_NO_SESSION", f'session "{session_id}" 不存在')

    def pages(self) -> List[Page]:
        return [Page(self, item) for item in self.sessions()]

    def stop_daemon(self) -> None:
        try:
            self.rpc("daemon.stop", {}, timeout=3.0)
        except BridgeError:
            pass


def connect(**options: Any) -> BrowserBridge:
    return BrowserBridge.connect(**options)


def write_data_url(path: Union[str, Path], data_url: str) -> Path:
    marker = str(data_url or "").find(",")
    if marker < 0:
        raise BridgeError("E_INTERNAL", "截图结果不是 dataUrl")
    output = Path(path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(str(data_url)[marker + 1 :]))
    return output


# =============================================================================
# 第十批-B：错误恢复映射 / 重试 / 进度追踪 / 取消作用域 / 全部 MCP 工具覆盖审计
#
# 这些能力与 Node 侧一一对齐：
#   - mcp/error-map.mjs      → ERROR_FAMILIES / error_family / retry_plan / retry_delay_ms
#   - mcp/progress.mjs       → ProgressTracker（阶段与终态不变式）
#   - mcp/cancel.mjs         → CancellationScope（外部线程取消在途调用）
#   - mcp/completion.mjs     → McpToolClient.complete / complete_*_argument
#   - sdk/tool-catalog.mjs   → TOOL_CATALOG / tool_coverage 的三方对账
#
# 原则：Python 侧不新增错误码（ERROR_CODES 是协议清单的镜像），只做分类与建议；
# 未知码一律 family="unknown" / retry="no"，不猜、不吞。
# =============================================================================

RETRY_POLICY = {
    "max_attempts": 3,
    "base_delay_ms": 250,
    "max_delay_ms": 4000,
    "jitter": True,
    # lib/error-codes.mjs 的 recovery.retry 只有 no / after-action / transient。
    # 自动重试只对 transient（会话忙/队列满/限流）有意义；after-action 表示“先做动作再重试”。
    "retryable_retry_modes": ("yes", "transient"),
    "action_retry_modes": ("after-action", "after-fix"),
}

ERROR_FAMILIES = (
    "validation",
    "session",
    "transport",
    "cancellation",
    "timeout",
    "resource",
    "approval",
    "protocol",
    "ledger",
    "internal",
    "unknown",
)

# 顺序匹配（第一条命中即用），与 mcp/error-map.mjs 的 CATEGORY_RULES 逐条对应。
_ERROR_FAMILY_RULES = (
    (re.compile(r"^E_(ARG|TOKEN|EVAL_DOM_ARGS|UNKNOWN_FLAG|BAD_SUBCOMMAND)"), "validation"),
    (re.compile(r"^E_HUMAN_GATE$"), "approval"),
    (re.compile(r"^E_CANCEL|^E_REQUEST_CANCELLED$|^E_INPUT_BUSY$"), "cancellation"),
    (re.compile(r"TIMEOUT|^E_DEADLINE|^E_START_PENDING$|^E_START_NOT_READY$"), "timeout"),
    (re.compile(r"^E_DAEMON|^E_CONNECT|^E_DISCONNECTED|^E_WS_|^E_RPC$|^E_ENV$"), "transport"),
    (re.compile(r"^E_SESSION|^E_NO_SESSION|^E_QUEUE_FULL|^E_RATE_LIMITED|^E_TAB_LEASE|^E_NO_TAB$|^E_NO_BROWSER$|^E_BROWSER_AMBIGUOUS$"), "session"),
    (re.compile(r"^E_LEDGER"), "ledger"),
    (re.compile(r"^E_(NOT_FOUND|STALE_REF|CURSOR_STALE|OBSERVATION_STALE|OBSERVATION_CHANGED|TARGET_DETACHED|SNAPSHOT_CORRUPT|SNAPSHOT_DISABLED|SNAPSHOT_WRITE|CAPTURE_)"), "resource"),
    (re.compile(r"^E_(PROTOCOL|UNSUPPORTED|UNKNOWN_METHOD|DEPENDS_FAILED|EXPECT_FAILED|CONTEXT_|COOPERATION_|OPTION_)"), "protocol"),
    (re.compile(r"^E_(INTERNAL|UNEXPECTED|CONFIG|STATE)"), "internal"),
)

NON_RETRYABLE_CODES = frozenset({
    "E_DAEMON",
    "E_DISCONNECTED",
    "E_ENV",
    "E_NO_SESSION",
    "E_SESSION_STOPPED",
    "E_HUMAN_GATE",
    "E_UNSUPPORTED_CAPABILITY",
    "E_UNKNOWN_METHOD",
    "E_PROTOCOL_UNSUPPORTED",
    "E_CANCELLED",
    "E_REQUEST_CANCELLED",
    "E_SNAPSHOT_DISABLED",
    "E_ARG_MISSING",
    "E_ARG_TYPE",
    "E_ARG_ENUM",
    "E_ARG_UNEXPECTED",
    "E_TARGET_DETACHED",
})

TERMINAL_CODES = frozenset({"E_DAEMON", "E_DISCONNECTED", "E_ENV", "E_SESSION_STOPPED", "E_NO_SESSION"})


def recovery_for(code: Any) -> Tuple[str, str]:
    """错误码 → (retry, hint)；未知码返回 ("no","")，与 lib/error-codes.recoveryHint 一致。"""
    return RECOVERY_HINTS.get(str(code or ""), ("no", ""))


def error_family(code: Any) -> str:
    """错误码 → 大类（validation/session/transport/...）；未知返回 unknown。"""
    value = str(code or "").strip() or "E_INTERNAL"
    for pattern, family in _ERROR_FAMILY_RULES:
        if pattern.search(value):
            return family
    return "internal" if value == "E_INTERNAL" else "unknown"


def classify_error_code(code: Any) -> Dict[str, Any]:
    """错误码的结构化分类（与 Node classifyErrorCode 的字段对齐）。"""
    value = str(code or "").strip() or "E_INTERNAL"
    retry, hint = recovery_for(value)
    return {
        "code": value,
        "category": error_family(value),
        "retry": retry,
        "hint": hint,
        "terminal": value in TERMINAL_CODES,
        "non_retryable": value in NON_RETRYABLE_CODES,
        "json_rpc_code": {
            "E_BAD_ARG": -32602,
            "E_ARG_MISSING": -32602,
            "E_ARG_TYPE": -32602,
            "E_ARG_ENUM": -32602,
            "E_ARG_CONFLICT": -32602,
            "E_ARG_REQUIRES": -32602,
            "E_ARG_RANGE": -32602,
            "E_ARG_UNEXPECTED": -32602,
            "E_ARG_USAGE": -32602,
            "E_UNKNOWN_FLAG": -32602,
            "E_UNKNOWN_METHOD": -32601,
            "E_UNSUPPORTED": -32601,
            "E_UNSUPPORTED_CAPABILITY": -32601,
            "E_NOT_FOUND": -32002,
            "E_STALE_REF": -32002,
            "E_CURSOR_STALE": -32002,
            "E_OBSERVATION_STALE": -32002,
        }.get(value, -32603),
        "known_family": error_family(value) != "unknown",
    }


def retry_delay_ms(attempt: int, code: Any = "", base_delay_ms: Optional[int] = None,
                   max_delay_ms: Optional[int] = None, jitter: Optional[bool] = None) -> int:
    """指数退避 + 确定性抖动；与 mcp/error-map.mjs 的 retryDelayMs 逐位一致。

    seed 计算：seed = (seed * 31 + ord(ch)) & 0xFFFFFFFF，factor = 0.85 + (seed % 300)/1000。
    """
    base = int(RETRY_POLICY["base_delay_ms"] if base_delay_ms is None else base_delay_ms)
    cap = int(RETRY_POLICY["max_delay_ms"] if max_delay_ms is None else max_delay_ms)
    use_jitter = RETRY_POLICY["jitter"] if jitter is None else bool(jitter)
    index = max(0, int(attempt))
    raw = min(cap, base * (2 ** index))
    if not use_jitter:
        return raw
    seed = 0
    for char in f"{code}:{index}":
        seed = (seed * 31 + ord(char)) & 0xFFFFFFFF
    factor = 0.85 + ((seed % 300) / 1000)
    # 与 JS Math.round 对齐：四舍五入（.5 向上），不能用 Python 银行家舍入。
    return max(0, int(math.floor(min(cap, raw * factor) + 0.5)))


def is_retryable(code: Any, attempt: int = 1, max_attempts: Optional[int] = None) -> bool:
    """是否值得自动重试：非不可重试码、非终端错误、recovery 建议为 yes/transient。"""
    limit = int(max_attempts or RETRY_POLICY["max_attempts"])
    if attempt >= limit:
        return False
    value = str(code or "")
    if value in NON_RETRYABLE_CODES or value in TERMINAL_CODES:
        return False
    retry, _hint = recovery_for(value)
    return retry in RETRY_POLICY["retryable_retry_modes"]


def needs_action_before_retry(code: Any) -> bool:
    """是否属于“先做动作再重试”（after-action），用于给客户端更准确的下一步。"""
    retry, _hint = recovery_for(code)
    return retry in RETRY_POLICY["action_retry_modes"]


def retry_plan(code: Any, attempt: int = 1, max_attempts: Optional[int] = None) -> Dict[str, Any]:
    """重试计划（与 Node retryPlan 字段对齐；客户端可直接照做）。"""
    limit = int(max_attempts or RETRY_POLICY["max_attempts"])
    retryable = is_retryable(code, attempt=attempt, max_attempts=limit)
    value = str(code or "")
    retry, _hint = recovery_for(code)
    needs_action = (not retryable) and needs_action_before_retry(code)
    if not retryable and attempt >= limit:
        reason = "attempts-exhausted"
    elif not retryable and value in NON_RETRYABLE_CODES:
        reason = "non-retryable-code"
    elif needs_action:
        reason = "needs-action"
    elif not retryable:
        reason = "recovery-mode-" + retry
    else:
        reason = "retryable-" + retry
    return {
        "retryable": retryable,
        "attempt": max(1, int(attempt)),
        "max_attempts": limit,
        "delay_ms": retry_delay_ms(int(attempt) - 1, code=code) if retryable else 0,
        "reason": reason,
        "needs_action": needs_action,
        "category": error_family(code),
    }


class ProgressTracker:
    """收集 on_progress 事件并校验终态不变式（thread-safe）。

    与 mcp/progress.mjs 的语义对齐：
      - 第一事件为 start，最后必须且只能有一个终态（done/error/cancelled）；
      - phase="progress" 是 server 的 notifications/progress（仅 progress=True 时出现）；
      - 回调异常被吞掉（不能让 UI 抛错打断工具调用）。
    """

    PHASES = ("start", "progress", "retry", "done", "error", "cancelled")
    TERMINAL_PHASES = ("done", "error", "cancelled")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.events: List[Dict[str, Any]] = []

    def handler(self, *sinks: Any) -> Any:
        """返回可直接传给 call_tool(on_progress=...) 的回调；额外 sink 会收到同一事件。"""
        def _on_progress(event: Dict[str, Any]) -> None:
            with self._lock:
                self.events.append(dict(event))
            for sink in sinks:
                try:
                    sink(dict(event))
                except Exception:  # noqa: BLE001 - 回调失败不中断工具调用
                    pass
        return _on_progress

    def __len__(self) -> int:
        with self._lock:
            return len(self.events)

    def phases(self) -> List[str]:
        with self._lock:
            return [str(event.get("phase")) for event in self.events]

    def terminal_phases(self) -> List[str]:
        return [phase for phase in self.phases() if phase in self.TERMINAL_PHASES]

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            events = [dict(event) for event in self.events]
        phases = [str(event.get("phase")) for event in events]
        terminal = [phase for phase in phases if phase in self.TERMINAL_PHASES]
        return {
            "events": len(events),
            "phases": phases,
            "final_phase": phases[-1] if phases else None,
            "saw_start": "start" in phases,
            "saw_done": "done" in phases,
            "saw_error": "error" in phases,
            "saw_cancelled": "cancelled" in phases,
            "progress_samples": phases.count("progress"),
            "terminal_phases": terminal,
            "single_terminal": len(terminal) <= 1,
            "valid": (not phases or phases[0] == "start") and len(terminal) <= 1,
        }

    def assert_valid(self) -> Dict[str, Any]:
        """终态不变式不满足时抛 E_INTERNAL（消息带“进度事件序列非法”），测试/严格模式用。"""
        summary = self.summary()
        if not summary["valid"]:
            raise BridgeError("E_INTERNAL", f"进度事件序列非法：{summary['phases']}")
        return summary


class CancellationScope:
    """跨线程取消作用域：把“什么时候取消”与“怎么取消在途请求”解耦。

    用法::

        scope = CancellationScope()
        with scope:
            client.call_tool("browser_observe", {}, cancel_scope=scope, on_progress=tracker.handler())
        # 另一个线程 / 定时器：
        schedule = scope.cancel_after(0.3, reason="user-abort")

    语义（与 MCP notifications/cancelled 对齐）：
      - 取消是尽力而为：只停止等待并转发取消，不假装工具已回滚；
      - 已取消后再 attach 的请求会被立即取消（避免竞态漏取消）；
      - 定时器线程 daemon 化，不阻止进程退出。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._reason = ""
        self._request_id: Optional[int] = None
        self._cancel_fn: Optional[Any] = None
        self._timer: Optional[threading.Timer] = None
        self._callbacks: List[Any] = []

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    @property
    def reason(self) -> str:
        with self._lock:
            return self._reason

    def cancel(self, reason: str = "") -> bool:
        """标记取消；已取消返回 False（幂等）。已登记的在途请求会立刻转发取消。"""
        with self._lock:
            if self._cancelled:
                return False
            self._cancelled = True
            self._reason = str(reason or "")
            request_id, cancel_fn, callbacks = self._request_id, self._cancel_fn, list(self._callbacks)
            self._timer = None
        if request_id is not None and callable(cancel_fn):
            try:
                cancel_fn(request_id, self._reason)
            except Exception:  # noqa: BLE001 - 转发失败不影响本地取消
                pass
        for callback in callbacks:
            try:
                callback(self._reason)
            except Exception:  # noqa: BLE001
                pass
        return True

    def attach(self, request_id: int, cancel_fn: Optional[Any] = None) -> None:
        """登记在途请求（call_tool 的 on_request 会自动调用）；已取消则立即转发。"""
        with self._lock:
            self._request_id = int(request_id)
            self._cancel_fn = cancel_fn
            already = self._cancelled
            reason = self._reason
        if already and callable(cancel_fn):
            try:
                cancel_fn(int(request_id), reason)
            except Exception:  # noqa: BLE001
                pass

    def detach(self) -> None:
        with self._lock:
            self._request_id = None
            self._cancel_fn = None

    def cancel_after(self, seconds: float, reason: str = "timeout") -> "CancellationScope":
        """seconds 后自动取消；返回自身便于链式（定时器 daemon 化）。"""
        timer = threading.Timer(max(0.0, float(seconds)), lambda: self.cancel(reason))
        timer.daemon = True
        with self._lock:
            self._timer = timer
        timer.start()
        return self

    def add_callback(self, callback: Any) -> Any:
        if not callable(callback):
            raise BridgeError("E_ARG_TYPE", "取消回调必须可调用")
        with self._lock:
            self._callbacks.append(callback)
        return callback

    def dispose(self) -> None:
        with self._lock:
            timer = self._timer
            self._timer = None
        if timer is not None:
            try:
                timer.cancel()
            except Exception:  # noqa: BLE001
                pass

    def __enter__(self) -> "CancellationScope":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.dispose()


def tool_coverage() -> Dict[str, Any]:
    """全部 MCP 工具覆盖审计（无需连接）：目录、分档、审批、超时、分页、方法映射。"""
    names = list(TOOL_CATALOG_META["order"])
    missing = [name for name in names if name not in TOOL_CATALOG]
    spec_errors: List[Dict[str, Any]] = []
    by_tier = {"read": 0, "mutate": 0, "destructive": 0}
    approvals: List[str] = []
    paginated: List[str] = []
    for name in names:
        spec = TOOL_CATALOG.get(name)
        if not spec:
            continue
        tier = spec["tier"]
        by_tier[tier] = by_tier.get(tier, 0) + 1
        if spec["approval_required"]:
            approvals.append(name)
        if pagination_markers(name)["partial"]:
            paginated.append(name)
        if not isinstance(spec["timeout_ms"], int) or spec["timeout_ms"] < 1000:
            spec_errors.append({"tool": name, "code": "E_TOOL_TIMEOUT", "message": "timeout_ms 非法"})
        if spec["tier"] == "destructive" and not spec["approval_required"]:
            spec_errors.append({"tool": name, "code": "E_TOOL_APPROVAL", "message": "destructive 工具必须要求审批"})
    return {
        "total": len(names),
        "covered": len(names) - len(missing),
        "missing": missing,
        "by_tier": by_tier,
        "approvals": approvals,
        "paginated": paginated,
        "spec_errors": spec_errors,
        "complete": not missing and not spec_errors,
    }


def audit_error_map() -> Dict[str, Any]:
    """错误映射自检：核心族的分类与 Node 一致、不可重试集合有据（测试/诊断共用）。"""
    errors: List[Dict[str, str]] = []
    samples = {
        "E_ARG_MISSING": "validation",
        "E_HUMAN_GATE": "approval",
        "E_CANCELLED": "cancellation",
        "E_DAEMON": "transport",
        "E_SESSION_STOPPED": "session",
        "E_NOT_FOUND": "resource",
        "E_PROTOCOL_UNSUPPORTED": "protocol",
        "E_LEDGER_IO": "ledger",
        "E_TIMEOUT": "timeout",
    }
    for code, expected in samples.items():
        actual = error_family(code)
        if actual != expected:
            errors.append({"code": "error-map-category", "message": f"{code} 期望 {expected}，实际 {actual}"})
    for code in NON_RETRYABLE_CODES:
        if recovery_for(code)[0] == "yes":
            errors.append({"code": "error-map-retry", "message": f"{code} 标为不可重试但 recovery 建议 yes"})
    for code in TERMINAL_CODES:
        if code not in NON_RETRYABLE_CODES:
            errors.append({"code": "error-map-terminal", "message": f"{code} 是终端错误但不在 NON_RETRYABLE_CODES"})
    return {"ok": not errors, "errors": errors, "families": list(ERROR_FAMILIES)}
