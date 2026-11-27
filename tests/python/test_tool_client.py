"""tests/python/test_tool_client.py —— Python SDK 工具级调用面单测。

覆盖（不需要 node / 浏览器）：
  - 92 工具目录（分档/方法/必填/属性/审批/超时/分页）；
  - 本地参数校验（E_ARG_MISSING/TYPE/ENUM/RANGE/UNEXPECTED，与 MCP/Node 同名）；
  - call_tool 成功/文本/错误 data/错误码提取/progress 事件/超时；
  - 审批闸门（destructive 需要 approval；BB_MCP_APPROVAL=off 可关闭；browser_update 恒审批）；
  - call_tool_paged 按 cursor 续读、max_pages 上限；
  - Page.call_tool / BrowserBridge 工具级入口；
  - StdioMcpTransport 的 JSON-RPC 成功/错误/超时（真实 Python 子进程，不需要 node）。
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    ARG_ERROR_CODES,
    BridgeError,
    BrowserBridge,
    McpToolClient,
    Page,
    StdioMcpTransport,
    TOOL_APPROVAL_ALWAYS,
    TOOL_CATALOG,
    TOOL_CATALOG_META,
    ToolArgumentError,
    ToolCallError,
    assert_tool_args,
    list_tools,
    pagination_markers,
    tool_spec,
    tool_tier_summary,
    validate_tool_args,
)


class FakeTransport:
    """可注入的 MCP 传输：记录请求并按 handler 返回结果。"""

    def __init__(self, handler=None):
        self.handler = handler or (lambda method, params, timeout: {})
        self.requests = []
        self.notifications = []
        self.listeners = []
        self.closed = False

    def request(self, method, params=None, timeout=None):
        self.requests.append({"method": method, "params": params, "timeout": timeout})
        return self.handler(method, params, timeout)

    def notify(self, method, params=None):
        self.notifications.append({"method": method, "params": params})

    def add_notification_handler(self, handler):
        self.listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler):
        for index, listener in enumerate(self.listeners):
            if listener is handler:
                del self.listeners[index]
                return True
        return False

    def emit_notification(self, message):
        """模拟 server→client 通知（触发已注册的 listener）。"""
        for listener in list(self.listeners):
            listener(message)

    def close(self):
        self.closed = True

    def last(self):
        return self.requests[-1]


def tool_result(payload, is_error=False, error_code=None, extra_meta=None):
    """构造 MCP tools/call result（content + isError + _meta）。"""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    meta = {"browser-bridge/tier": "read", "browser-bridge/elapsedMs": 1}
    if error_code:
        meta["browser-bridge/errorCode"] = error_code
    if extra_meta:
        meta.update(extra_meta)
    return {"content": [{"type": "text", "text": text}], "isError": bool(is_error), "_meta": meta}


def make_client(handler):
    transport = FakeTransport(handler)
    home = tempfile.mkdtemp(prefix="bb-py-tool-")
    client = McpToolClient(home=home, transport=transport)
    return client, transport


def observe_handler(method, params, timeout):
    if method != "tools/call":
        return {}
    args = params.get("arguments") or {}
    if args.get("cursor") == "c2":
        return tool_result({"observation": "@e2 second", "cursor": "c3"})
    if args.get("cursor") == "c3":
        return tool_result({"observation": "@e3 third", "cursor": None})
    if params.get("name") == "browser_observe":
        return tool_result({"observation": "@e1 first", "cursor": "c2"})
    return tool_result({"ok": True, "method": params.get("name")})


class ToolCatalogTest(unittest.TestCase):
    def test_catalog_shape_and_meta(self):
        self.assertEqual(len(TOOL_CATALOG), 92)
        self.assertEqual(TOOL_CATALOG_META["tool_count"], 92)
        self.assertEqual(TOOL_CATALOG_META["protocol"], "1.9")
        self.assertEqual(len(TOOL_CATALOG_META["order"]), 92)
        self.assertEqual(len(set(TOOL_CATALOG_META["order"])), 92)
        self.assertEqual(TOOL_CATALOG_META["order"], tuple(row["name"] for row in list_tools()))

    def test_catalog_entries_preserve_tier_methods_and_props(self):
        observe = tool_spec("browser_observe")
        self.assertEqual(observe["tier"], "read")
        self.assertEqual(observe["methods"], ("observe",))
        self.assertIn("max_tokens", dict(observe["props"]))
        self.assertEqual(dict(observe["props"])["max_tokens"]["type"], "integer")
        self.assertEqual(observe["pagination"]["methods"], ("observe",))

        fill = tool_spec("browser_fill")
        self.assertEqual(fill["tier"], "mutate")
        self.assertEqual(fill["required"], ("value",))
        self.assertIsNone(fill["pagination"])

        window = tool_spec("browser_window")
        self.assertEqual(dict(window["props"])["action"]["enum"][0], "list")
        screenshot = tool_spec("browser_screenshot")
        self.assertEqual(tuple(dict(screenshot["props"])["region"]["type"]), ("string", "object"))

        update = tool_spec("browser_update")
        self.assertTrue(update["approval_required"])
        self.assertTrue(update["approval_always"])
        self.assertEqual(TOOL_APPROVAL_ALWAYS, ("browser_update",))
        self.assertEqual(tool_spec("browser_evaluate")["tier"], "destructive")
        self.assertIsNone(tool_spec("browser_not_real"))

    def test_tier_summary_and_pagination(self):
        summary = tool_tier_summary()
        self.assertEqual(summary["total"], 92)
        self.assertEqual(summary["byTier"], {"read": 36, "mutate": 49, "destructive": 7})
        self.assertEqual(summary["byTier"]["read"] + summary["byTier"]["mutate"] + summary["byTier"]["destructive"], 92)
        self.assertIn("browser_evaluate", summary["approvals"])
        self.assertIn("browser_update", summary["approvals"])
        self.assertEqual(summary["paginated"], [
            "browser_brief",
            "browser_observe",
            "browser_extract",
            "browser_screenshot",
            "browser_longshot_recover",
            "browser_network_waterfall",
            "browser_network_list",
            "browser_console",
        ])
        self.assertTrue(pagination_markers("browser_observe")["partial"])
        self.assertFalse(pagination_markers("browser_click")["partial"])
        self.assertEqual(pagination_markers("browser_observe")["cursorParam"], "cursor")


class ToolValidationTest(unittest.TestCase):
    def test_valid_arguments_pass(self):
        self.assertTrue(validate_tool_args("browser_observe", {"max_tokens": 500})["ok"])
        self.assertTrue(validate_tool_args("browser_click", {"ref": "@e1", "trusted": True})["ok"])
        self.assertTrue(validate_tool_args("browser_fill", {"ref": "@e1", "value": "bridge"})["ok"])
        self.assertTrue(validate_tool_args("browser_plan", {"steps": [{"method": "click", "params": {"ref": "@e1"}}]})["ok"])
        self.assertTrue(validate_tool_args("browser_status", {})["ok"])

    def test_missing_required(self):
        result = validate_tool_args("browser_fill", {"ref": "@e1"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["errors"][0]["code"], ARG_ERROR_CODES["MISSING"])
        self.assertEqual(result["errors"][0]["path"], "value")

    def test_type_enum_range_unexpected(self):
        type_error = validate_tool_args("browser_tab_close", {"tab_id": "x"})
        self.assertEqual(type_error["errors"][0]["code"], "E_ARG_TYPE")
        self.assertEqual(type_error["errors"][0]["path"], "tab_id")
        enum_error = validate_tool_args("browser_window", {"action": "explode"})
        self.assertEqual(enum_error["errors"][0]["code"], "E_ARG_ENUM")
        range_error = validate_tool_args("browser_network_waterfall", {"limit": 0})
        self.assertEqual(range_error["errors"][0]["code"], "E_ARG_RANGE")
        unexpected = validate_tool_args("browser_status", {"nope": 1})
        self.assertEqual(unexpected["errors"][0]["code"], "E_ARG_UNEXPECTED")
        self.assertEqual(unexpected["errors"][0]["path"], "nope")
        self.assertEqual(validate_tool_args("browser_plan", {"steps": "x"})["errors"][0]["code"], "E_ARG_TYPE")
        self.assertEqual(validate_tool_args("browser_not_real", {})["errors"][0]["code"], "E_ARG_UNEXPECTED")
        self.assertEqual(validate_tool_args("browser_status", [1])["errors"][0]["code"], "E_ARG_TYPE")

    def test_assert_tool_args_raises_structured_error(self):
        with self.assertRaises(ToolArgumentError) as caught:
            assert_tool_args("browser_fill", {"ref": "@e1"})
        self.assertEqual(caught.exception.code, "E_ARG_MISSING")
        self.assertEqual(caught.exception.errors[0]["path"], "value")
        assert_tool_args("browser_observe", {})  # 不抛


class CallToolTest(unittest.TestCase):
    def test_success_returns_payload_and_progress(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({"observation": "@e1 ok", "refs": 1}))
        events = []
        payload = client.call_tool("browser_observe", {"max_tokens": 800}, on_progress=events.append)
        self.assertEqual(payload, {"observation": "@e1 ok", "refs": 1})
        self.assertEqual(transport.last()["method"], "tools/call")
        self.assertEqual(transport.last()["params"]["name"], "browser_observe")
        self.assertEqual(transport.last()["params"]["arguments"], {"max_tokens": 800})
        self.assertNotIn("_meta", transport.last()["params"])
        self.assertEqual(transport.last()["timeout"], 60.0)
        self.assertEqual([event["phase"] for event in events], ["start", "done"])
        self.assertGreaterEqual(events[-1]["elapsed_ms"], 0.0)
        self.assertEqual(events[-1]["tier"], "read")

    def test_non_json_text_payload_returned_as_text(self):
        client, _transport = make_client(lambda method, params, timeout: tool_result("plain text result"))
        self.assertEqual(client.call_tool("browser_status", {}), "plain text result")

    def test_error_meta_becomes_tool_call_error(self):
        def handler(method, params, timeout):
            return tool_result("E_TIMEOUT: 工具 browser_observe 超过 60000ms 未返回", is_error=True, error_code="E_TIMEOUT")

        client, _transport = make_client(handler)
        events = []
        with self.assertRaises(ToolCallError) as caught:
            client.call_tool("browser_observe", {}, on_progress=events.append)
        error = caught.exception
        self.assertEqual(error.code, "E_TIMEOUT")
        self.assertEqual(error.tool, "browser_observe")
        payload = error.to_dict()
        self.assertEqual(payload["retry"], "after-action")
        self.assertEqual(payload["tool"], "browser_observe")
        self.assertEqual([event["phase"] for event in events], ["start", "error"])
        self.assertEqual(events[-1]["code"], "E_TIMEOUT")

    def test_error_code_parsed_from_text_when_meta_missing(self):
        client, _transport = make_client(lambda method, params, timeout: tool_result("E_LEDGER_PENDING: 有未确认记录", is_error=True))
        with self.assertRaises(ToolCallError) as caught:
            client.call_tool("browser_observe", {})
        self.assertEqual(caught.exception.code, "E_LEDGER_PENDING")
        self.assertEqual(caught.exception.to_dict()["retry"], "after-action")
        client2, _ = make_client(lambda method, params, timeout: tool_result("no-code-here", is_error=True))
        with self.assertRaises(ToolCallError) as caught2:
            client2.call_tool("browser_observe", {})
        self.assertEqual(caught2.exception.code, "E_INTERNAL")

    def test_unknown_tool_rejected_before_transport(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({}))
        with self.assertRaises(ToolCallError) as caught:
            client.call_tool("browser_not_real", {})
        self.assertEqual(caught.exception.code, "E_ARG_UNEXPECTED")
        self.assertEqual(transport.requests, [])

    def test_validation_can_be_disabled(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({"ok": True}))
        client.call_tool("browser_observe", {"bogus": 1}, validate=False)
        self.assertEqual(transport.last()["params"]["arguments"], {"bogus": 1})

    def test_explicit_timeout_and_transport_errors_propagate(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({"ok": True}))
        client.call_tool("browser_observe", {}, timeout=1.5)
        self.assertEqual(transport.last()["timeout"], 1.5)

        def timeout_handler(method, params, timeout):
            raise BridgeError("E_TIMEOUT", "MCP tools/call 超过 1s 未返回")

        client2, _ = make_client(timeout_handler)
        events = []
        with self.assertRaises(BridgeError) as caught:
            client2.call_tool("browser_observe", {}, on_progress=events.append)
        self.assertEqual(caught.exception.code, "E_TIMEOUT")
        self.assertEqual(events[-1]["phase"], "error")

    def test_multiple_text_chunks_joined(self):
        def handler(method, params, timeout):
            return {"content": [{"type": "text", "text": "line-1"}, {"type": "text", "text": "line-2"}], "isError": False, "_meta": {}}

        client, _transport = make_client(handler)
        self.assertEqual(client.call_tool("browser_status", {}), "line-1\nline-2")


class ApprovalTest(unittest.TestCase):
    def test_destructive_requires_approval(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({"value": 2}))
        with self.assertRaises(ToolCallError) as caught:
            client.call_tool("browser_evaluate", {"expression": "1 + 1"})
        self.assertEqual(caught.exception.code, "E_HUMAN_GATE")
        self.assertEqual(caught.exception.tool, "browser_evaluate")
        self.assertEqual(transport.requests, [])

        client.call_tool("browser_evaluate", {"expression": "1 + 1"}, approval=True)
        self.assertEqual(transport.last()["params"]["_meta"], {"browser-bridge/approval": "confirmed"})

    def test_env_off_disables_gate_except_always(self):
        with mock.patch.dict(os.environ, {"BB_MCP_APPROVAL": "off"}, clear=False):
            client, transport = make_client(lambda method, params, timeout: tool_result({"ok": True}))
            client.call_tool("browser_evaluate", {"expression": "2 + 2"})
            self.assertNotIn("_meta", transport.last()["params"])
            with self.assertRaises(ToolCallError) as caught:
                client.call_tool("browser_update", {"action": "check"})
            self.assertEqual(caught.exception.code, "E_HUMAN_GATE")

    def test_replaceable_env_gate_protects_sensitive_tools(self):
        with mock.patch.dict(os.environ, {"BB_MCP_APPROVAL": "required"}, clear=False):
            client, _transport = make_client(lambda method, params, timeout: tool_result({"ok": True}))
            with self.assertRaises(ToolCallError) as caught:
                client.call_tool("browser_settings", {"action": "get"})
            self.assertEqual(caught.exception.code, "E_HUMAN_GATE")


class PaginationTest(unittest.TestCase):
    def test_call_tool_paged_follows_cursor(self):
        client, transport = make_client(observe_handler)
        pages = client.call_tool_paged("browser_observe", {}, max_pages=5)
        self.assertEqual([page["observation"] for page in pages], ["@e1 first", "@e2 second", "@e3 third"])
        self.assertEqual(len(transport.requests), 3)
        self.assertEqual(transport.requests[1]["params"]["arguments"], {"cursor": "c2"})
        self.assertEqual(transport.requests[2]["params"]["arguments"], {"cursor": "c3"})

    def test_call_tool_paged_respects_max_pages(self):
        client, transport = make_client(observe_handler)
        pages = client.call_tool_paged("browser_observe", {}, max_pages=1)
        self.assertEqual(len(pages), 1)
        self.assertEqual(len(transport.requests), 1)

    def test_call_tool_paged_non_partial_returns_single(self):
        client, transport = make_client(lambda method, params, timeout: tool_result({"ok": True, "cursor": "should-ignore"}))
        pages = client.call_tool_paged("browser_click", {"ref": "@e1"})
        self.assertEqual(pages, [{"ok": True, "cursor": "should-ignore"}])
        self.assertEqual(len(transport.requests), 1)

    def test_call_tool_paged_rejects_bad_max_pages(self):
        client, _transport = make_client(lambda method, params, timeout: tool_result({}))
        with self.assertRaises(BridgeError) as caught:
            client.call_tool_paged("browser_observe", {}, max_pages=0)
        self.assertEqual(caught.exception.code, "E_ARG_RANGE")


class ResourceSubscriptionTest(unittest.TestCase):
    """W7-C：resources/subscribe 的 Python 调用面（本地镜像 + 通知回调）。"""

    @staticmethod
    def handler(method, params, timeout):
        if method == "resources/subscribe":
            return {
                "_meta": {
                    "browser-bridge/subscription": {
                        "uri": params["uri"],
                        "added": True,
                        "enabled": True,
                        "count": 1,
                        "max": 256,
                        "evicted": None,
                        "notification": "notifications/resources/updated",
                    },
                },
            }
        if method == "resources/unsubscribe":
            return {
                "_meta": {
                    "browser-bridge/subscription": {
                        "uri": params["uri"],
                        "found": True,
                        "removed": True,
                        "count": 0,
                        "max": 256,
                    },
                },
            }
        return {}

    def test_subscribe_and_unsubscribe_track_local_mirror(self):
        client, transport = make_client(self.handler)
        report = client.subscribe_resource("bridge://observation/latest")
        self.assertEqual(report["uri"], "bridge://observation/latest")
        self.assertEqual(report["added"], True)
        self.assertEqual(report["notification"], "notifications/resources/updated")
        self.assertEqual(transport.last()["method"], "resources/subscribe")
        self.assertEqual(transport.last()["params"], {"uri": "bridge://observation/latest"})
        self.assertEqual(client.resource_subscriptions(), ["bridge://observation/latest"])
        self.assertFalse(client.supports_resource_subscriptions(), "未握手时 capabilities 为空")

        removed = client.unsubscribe_resource("bridge://observation/latest")
        self.assertEqual(removed["found"], True)
        self.assertEqual(transport.last()["method"], "resources/unsubscribe")
        self.assertEqual(client.resource_subscriptions(), [])

    def test_close_clears_subscription_mirror(self):
        client, transport = make_client(self.handler)
        client.subscribe_resource("bridge://debug/journal/latest")
        self.assertEqual(client.resource_subscriptions(), ["bridge://debug/journal/latest"])
        client.close()
        self.assertTrue(transport.closed)
        self.assertEqual(client.resource_subscriptions(), [])

    def test_resource_updated_handler_filters_method_and_swallows_errors(self):
        client, transport = make_client(self.handler)
        seen = []
        handler = client.add_resource_updated_handler(seen.append)
        self.assertTrue(callable(handler))
        transport.emit_notification({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": "x"}})
        self.assertEqual(seen, [], "非 resources/updated 通知不回调")
        payload = {"uri": "bridge://observation/latest", "_meta": {"browser-bridge/resource-update": {"action": "record"}}}
        transport.emit_notification({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": payload})
        self.assertEqual(seen, [payload])

        boom = client.add_resource_updated_handler(lambda _params: (_ for _ in ()).throw(RuntimeError("boom")))
        transport.emit_notification({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": payload})
        self.assertTrue(client.remove_resource_updated_handler(boom))
        self.assertFalse(client.remove_resource_updated_handler(boom))
        self.assertTrue(client.remove_resource_updated_handler(handler))

    def test_handler_requires_transport_support(self):
        class BareTransport:
            def request(self, method, params=None, timeout=None):
                return {}

            def close(self):
                pass

        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-bare-"), transport=BareTransport())
        with self.assertRaises(BridgeError) as caught:
            client.add_resource_updated_handler(lambda _params: None)
        self.assertEqual(caught.exception.code, "E_UNSUPPORTED_CAPABILITY")
        with self.assertRaises(BridgeError) as bad:
            client.add_resource_updated_handler(None)
        self.assertEqual(bad.exception.code, "E_ARG_TYPE")

    def test_bridge_facade_delegates_subscription_calls(self):
        transport = FakeTransport(self.handler)
        bridge = BrowserBridge({"port": 1, "token": "tok"}, home=tempfile.mkdtemp(prefix="bb-py-bridge-sub-"))
        bridge._tool_client = McpToolClient(home=bridge.home, transport=transport)
        report = bridge.subscribe_resource("bridge://observation/latest")
        self.assertEqual(report["uri"], "bridge://observation/latest")
        self.assertEqual(transport.last()["method"], "resources/subscribe")
        self.assertEqual(bridge.resource_subscriptions(), ["bridge://observation/latest"])
        handler = bridge.add_resource_updated_handler(lambda _params: None)
        self.assertTrue(bridge.remove_resource_updated_handler(handler))
        bridge.unsubscribe_resource("bridge://observation/latest")
        self.assertEqual(bridge.resource_subscriptions(), [])


class ClientLifecycleTest(unittest.TestCase):
    def test_connect_initialize_and_close(self):
        transport = FakeTransport(lambda method, params, timeout: {
            "serverInfo": {"name": "browser-bridge", "version": "test"},
            "capabilities": {"resources": {"subscribe": True, "subscription": {"notification": "notifications/resources/updated"}}},
        })
        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-life-"), transport=transport)
        client.connect()
        self.assertTrue(client.connected)
        self.assertEqual(client.server_info["name"], "browser-bridge")
        self.assertEqual(client.capabilities["resources"]["subscribe"], True)
        self.assertEqual(transport.requests[0]["method"], "initialize")
        self.assertEqual(transport.requests[0]["params"]["protocolVersion"], "2024-11-05")
        self.assertEqual(transport.notifications[0]["method"], "notifications/initialized")
        client.connect()  # 幂等
        self.assertEqual(len(transport.requests), 1)
        client.close()
        self.assertFalse(client.connected)
        self.assertTrue(transport.closed)
        with self.assertRaises(BridgeError) as caught:
            client.call_tool("browser_status", {})
        self.assertEqual(caught.exception.code, "E_DISCONNECTED")
        client.close()  # 二次 close 不抛

    def test_connect_after_close_uses_new_transport(self):
        transport = FakeTransport(lambda method, params, timeout: {"serverInfo": {"name": "x"}, "capabilities": {}})
        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-life2-"), transport=transport)
        client.connect()
        client.close()
        replacement = FakeTransport(lambda method, params, timeout: {"serverInfo": {"name": "y"}, "capabilities": {}})
        client._transport = replacement
        client.connect()
        self.assertTrue(client.connected)
        self.assertEqual(client.server_info["name"], "y")

    def test_mcp_read_helpers(self):
        def handler(method, params, timeout):
            if method == "tools/list":
                return {"tools": [{"name": "browser_status"}]}
            if method == "prompts/list":
                return {"prompts": [{"name": "har_analysis"}]}
            if method == "prompts/get":
                return {"messages": [{"role": "user", "content": {"type": "text", "text": "hi"}}]}
            if method == "resources/list":
                return {"resources": [{"uri": "bridge://protocol/summary"}]}
            if method == "resources/read":
                return {"contents": [{"uri": params["uri"], "text": "{}"}]}
            return {}

        client, transport = make_client(handler)
        self.assertEqual(client.list_mcp_tools()[0]["name"], "browser_status")
        self.assertEqual(client.list_prompts()[0]["name"], "har_analysis")
        self.assertEqual(client.get_prompt("har_analysis", {"source": "latest"})["messages"][0]["content"]["text"], "hi")
        self.assertEqual(client.list_resources()[0]["uri"], "bridge://protocol/summary")
        self.assertEqual(client.read_resource("bridge://protocol/summary")["contents"][0]["text"], "{}")
        self.assertEqual(transport.requests[-1]["method"], "resources/read")
        self.assertEqual(transport.requests[-1]["params"], {"uri": "bridge://protocol/summary"})


class BridgeIntegrationTest(unittest.TestCase):
    def _bridge(self):
        home = tempfile.mkdtemp(prefix="bb-py-bridge-tools-")
        bridge = BrowserBridge({"port": 1, "token": "tok"}, home=home)
        return bridge

    def test_bridge_tool_catalog_entrypoints(self):
        bridge = self._bridge()
        self.assertEqual(len(bridge.tools()), 92)
        self.assertEqual(bridge.tool_spec("browser_observe")["tier"], "read")
        self.assertEqual(bridge.validate_tool_args("browser_fill", {"ref": "@e1"})["errors"][0]["code"], "E_ARG_MISSING")
        self.assertEqual(bridge.tool_tier_summary()["total"], 92)
        self.assertEqual(bridge.pagination("browser_observe")["methods"], ["observe"])
        self.assertEqual(bridge.next_page("browser_observe", {"cursor": "c9"}), {"cursor": "c9"})

    def test_close_tools_idempotent_without_client(self):
        bridge = self._bridge()
        self.assertEqual(bridge.close_tools(), {"ok": True, "closed": False})
        self.assertEqual(bridge.close_tools(), {"ok": True, "closed": False})

    def test_page_call_tool_auto_session(self):
        bridge = self._bridge()
        calls = []

        class StubClient:
            def connect(self):
                return self

            def call_tool(self, name, args, **options):
                calls.append({"name": name, "args": dict(args), "options": options})
                return {"ok": True}

            def call_tool_paged(self, name, args, **options):
                calls.append({"name": name, "args": dict(args), "options": options})
                return [{"ok": True}]

        bridge._tool_client = StubClient()
        page = Page(bridge, {"sessionId": "page-1"})
        page.call_tool("browser_observe", {"max_tokens": 100})
        self.assertEqual(calls[-1]["args"], {"max_tokens": 100, "session": "page-1"})
        page.call_tool("browser_status", {})
        self.assertEqual(calls[-1]["args"], {})
        page.call_tool_paged("browser_observe", {})
        self.assertEqual(calls[-1]["args"], {"session": "page-1"})
        with self.assertRaises(ToolCallError):
            page.call_tool("browser_not_real", {})

    def test_bridge_close_tools_closes_client(self):
        bridge = self._bridge()
        transport = FakeTransport(lambda method, params, timeout: {})
        bridge._tool_client = McpToolClient(home=bridge.home, transport=transport)
        self.assertEqual(bridge.close_tools(), {"ok": True, "closed": True})
        self.assertTrue(transport.closed)
        self.assertIsNone(bridge._tool_client)


class StdioTransportTest(unittest.TestCase):
    def _spawn(self, code, timeout=5.0):
        transport = StdioMcpTransport([sys.executable, "-c", code], timeout=timeout)
        self.addCleanup(transport.close)
        return transport

    def test_request_success(self):
        code = (
            "import json, sys\n"
            "line = sys.stdin.readline()\n"
            "req = json.loads(line)\n"
            "print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': {'ok': True, 'method': req['method']}}), flush=True)\n"
            "sys.stdin.readline()\n"
        )
        transport = self._spawn(code)
        self.assertEqual(transport.request("ping", {}, timeout=3.0), {"ok": True, "method": "ping"})

    def test_jsonrpc_error_becomes_bridge_error(self):
        code = (
            "import json, sys\n"
            "line = sys.stdin.readline()\n"
            "req = json.loads(line)\n"
            "print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -32601, 'message': 'nope'}}), flush=True)\n"
            "sys.stdin.readline()\n"
        )
        transport = self._spawn(code)
        with self.assertRaises(BridgeError) as caught:
            transport.request("resources/subscribe", {}, timeout=3.0)
        self.assertEqual(caught.exception.code, "E_RPC")
        self.assertEqual(caught.exception.data["code"], -32601)

    def test_timeout_kills_child(self):
        code = "import sys, time\nsys.stdin.readline()\ntime.sleep(10)\n"
        transport = self._spawn(code, timeout=5.0)
        started = time.monotonic()
        with self.assertRaises(BridgeError) as caught:
            transport.request("tools/call", {}, timeout=0.3)
        elapsed = time.monotonic() - started
        self.assertEqual(caught.exception.code, "E_TIMEOUT")
        self.assertLess(elapsed, 3.0)
        self.assertIsNone(transport._proc)
        self.assertTrue(transport._closed)
        transport.close()  # 已 abort 后 close 不抛

    def test_notify_does_not_wait_for_response(self):
        code = "import sys\nsys.stdin.readline()\nsys.stdin.readline()\n"
        transport = self._spawn(code)
        transport.start()
        transport.notify("notifications/initialized", {})
        self.assertIsNotNone(transport._proc)


if __name__ == "__main__":
    unittest.main()
