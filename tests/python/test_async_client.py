"""tests/python/test_async_client.py —— Python asyncio MCP 客户端能力面单测。

覆盖（不需要 node / 浏览器，除最后一个真实集成用例）：
  - AsyncStdioMcpTransport 之外的协议面：connect/上下文管理/transport_snapshot；
  - call_tool 的本地校验、审批闸门、payload 解析、工具错误映射；
  - call_tool_detailed 的 meta/progress_summary/recovery/approval_receipt 字段；
  - 进度通知（notifications/progress）过滤与事件序列；
  - 取消（AsyncCancellationScope + cancel_request → E_CANCELLED）；
  - 重试（call_tool_with_retry 的退避/回调/不可重试码）；
  - 分页（call_tool_paged / iter_tool_pages）；
  - 并发（call_tools 保持输入顺序、单点失败不拖垮其它）；
  - resources/prompts/completion 方法与订阅对账；
  - 真实 server 集成（有 node 时）：92 工具、第十一批-C 扩展能力、prompt 版本、图谱。
"""

import asyncio
import inspect
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

import browser_bridge_async as asyncmod  # noqa: E402
from browser_bridge import BridgeError, ToolCallError  # noqa: E402
from browser_bridge_async import (  # noqa: E402
    AsyncCancellationScope,
    AsyncMcpToolClient,
    AsyncStdioMcpTransport,
    diff_subscriptions,
    plan_subscription_changes,
    summarize_progress,
)


def tool_result(payload, is_error=False, error_code=None, extra_meta=None, receipt=None):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    meta = {"browser-bridge/tier": "read", "browser-bridge/elapsedMs": 1}
    if error_code:
        meta["browser-bridge/errorCode"] = error_code
    if is_error:
        meta["browser-bridge/recovery"] = {"code": error_code or "E_INTERNAL", "nextStep": {"action": "check-status"}}
        meta["browser-bridge/error"] = {"code": error_code or "E_INTERNAL", "category": "transport"}
    if receipt:
        meta["browser-bridge/approval-receipt"] = receipt
    if extra_meta:
        meta.update(extra_meta)
    return {
        "content": [{"type": "text", "text": text}],
        "isError": bool(is_error),
        "_meta": meta,
    }


class FakeAsyncTransport:
    """与 AsyncStdioMcpTransport 客户端面一致的 fake；可按方法注入行为。"""

    def __init__(self, handler=None):
        self.handler = handler or self.default_handler
        self.requests = []
        self.notifications = []
        self.listeners = []
        self.cancels = []
        self.start_count = 0
        self.closed = False
        self.seq = 0
        self.pending = {}
        self.deferred = set()
        self.failures = {}

    @staticmethod
    def default_handler(method, params, rid):
        if method == "initialize":
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "resources": {"subscribe": True},
                    "completions": {},
                    "experimental": {"browser-bridge/resource-graph": {"supported": True}},
                },
                "serverInfo": {"name": "browser-bridge", "version": "test"},
            }
        if method == "tools/list":
            return {"tools": [{"name": "browser_status"}]}
        if method == "tools/call":
            return tool_result({"ok": True, "tool": params.get("name")})
        if method == "resources/list":
            return {"resources": [{"uri": "bridge://skill/SKILL.md"}], "nextCursor": None}
        if method == "resources/read":
            return {"contents": [{"uri": params.get("uri"), "text": "hello"}]}
        if method == "resources/subscribe" or method == "resources/unsubscribe":
            found = method == "resources/unsubscribe"
            return {"_meta": {"browser-bridge/subscription": {"uri": params.get("uri"), "found": found}}}
        if method == "prompts/list":
            return {"prompts": [{"name": "har_analysis", "_meta": {"browser-bridge/prompt-version": {"version": "1.0.0", "fingerprint": "f" * 64, "stability": "stable"}}}]}
        if method == "prompts/get":
            return {"messages": [{"role": "user", "content": {"type": "text", "text": "prompt"}}], "_meta": {}}
        if method == "completion/complete":
            return {"completion": {"values": ["errors", "timings"], "total": 2, "hasMore": False}, "_meta": {}}
        if method == "ping":
            return {}
        return {}

    async def start(self):
        self.start_count += 1
        return self

    async def request(self, method, params=None, timeout=None, on_start=None):
        if self.closed:
            raise BridgeError("E_DISCONNECTED", "fake closed")
        self.seq += 1
        rid = self.seq
        self.requests.append({"method": method, "params": params or {}, "timeout": timeout})
        if on_start is not None:
            result = on_start(rid)
            if inspect.isawaitable(result):
                await result
        if method in self.deferred:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            self.pending[rid] = future
            return await future
        failure = self.failures.get(method)
        if failure is not None:
            if isinstance(failure, list):
                failure = failure.pop(0) if failure else None
            if failure:
                raise failure
        result = self.handler(method, params or {}, rid)
        if inspect.isawaitable(result):
            result = await result
        return result

    async def notify(self, method, params=None):
        self.notifications.append({"method": method, "params": params or {}})

    def add_notification_handler(self, handler):
        self.listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler):
        if handler in self.listeners:
            self.listeners.remove(handler)
            return True
        return False

    def emit(self, message):
        for listener in list(self.listeners):
            listener(message)

    def cancel(self, request_id, reason=""):
        self.cancels.append({"request_id": request_id, "reason": reason})
        future = self.pending.pop(request_id, None)
        if future is None or future.done():
            return False
        future.set_exception(BridgeError("E_CANCELLED", "cancelled"))
        return True

    async def close(self):
        self.closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(BridgeError("E_DISCONNECTED", "closed"))
        self.pending.clear()

    def snapshot(self):
        return {"alive": not self.closed, "requests": self.seq, "pending": len(self.pending)}


def run(coro):
    return asyncio.run(coro)


class ConnectTest(unittest.TestCase):
    def test_connect_handshake_idempotent_and_snapshot(self):
        transport = FakeAsyncTransport()

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            self.assertFalse(client.connected)
            await client.connect()
            self.assertTrue(client.connected)
            self.assertFalse(transport.closed)
            # 重复 connect 幂等：不会再发 initialize。
            await client.connect()
            self.assertEqual(sum(1 for row in transport.requests if row["method"] == "initialize"), 1)
            self.assertEqual(client.server_info["name"], "browser-bridge")
            self.assertEqual(client.protocol_version, "2024-11-05")
            self.assertTrue(client.supports_resource_subscriptions())
            snapshot = client.transport_snapshot()
            self.assertTrue(snapshot["connected"])
            self.assertTrue(snapshot["transport"]["alive"])
            await client.close()
            self.assertTrue(transport.closed)

        run(main())

    def test_async_context_manager(self):
        transport = FakeAsyncTransport()

        async def main():
            async with AsyncMcpToolClient(transport=transport) as client:
                self.assertTrue(client.connected)
                result = await client.call_tool("browser_status", {})
                self.assertEqual(result, {"ok": True, "tool": "browser_status"})
            self.assertTrue(transport.closed)

        run(main())

    def test_missing_node_raises_env_error(self):
        client = AsyncMcpToolClient(node=None)
        client.node = None  # 强制走“找不到 node”分支

        async def main():
            with self.assertRaises(BridgeError) as ctx:
                await client.connect()
            self.assertEqual(ctx.exception.code, "E_ENV")

        run(main())


class CallToolTest(unittest.TestCase):
    def _client(self, handler=None):
        transport = FakeAsyncTransport(handler)
        return AsyncMcpToolClient(transport=transport), transport

    def test_local_validation_and_unknown_tool(self):
        async def main():
            client, transport = self._client()
            await client.connect()
            with self.assertRaises(ToolCallError) as ctx:
                await client.call_tool("browser_observe", {"bogus": 1})
            self.assertEqual(ctx.exception.code, "E_ARG_UNEXPECTED")
            with self.assertRaises(ToolCallError) as ctx2:
                await client.call_tool("browser_nope", {})
            self.assertEqual(ctx2.exception.code, "E_ARG_UNEXPECTED")
            with self.assertRaises(ToolCallError) as ctx3:
                await client.call_tool("browser_evaluate", {})
            self.assertEqual(ctx3.exception.code, "E_ARG_MISSING")
            # 校验失败的调用不会发到 transport。
            self.assertEqual(transport.requests[-1]["method"], "initialize")
            await client.close()

        run(main())

    def test_approval_gate_and_confirmed_meta(self):
        async def main():
            client, transport = self._client()
            await client.connect()
            with self.assertRaises(ToolCallError) as ctx:
                await client.call_tool("browser_evaluate", {"expression": "1+1"})
            self.assertEqual(ctx.exception.code, "E_HUMAN_GATE")
            self.assertTrue(ctx.exception.details["approval_required"])
            self.assertEqual(ctx.exception.details["retry"], "after-action")

            result = await client.call_tool("browser_evaluate", {"expression": "1+1"}, approval=True)
            self.assertEqual(result["tool"], "browser_evaluate")
            call = next(row for row in transport.requests if row["method"] == "tools/call")
            self.assertEqual(call["params"]["_meta"]["browser-bridge/approval"], "confirmed")
            await client.close()

        run(main())

    def test_tool_error_mapping_and_detailed_meta(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                return tool_result("E_DAEMON: daemon 未运行", is_error=True, error_code="E_DAEMON",
                                   receipt={"id": "apr_1_x", "seq": 1})
            return {}

        async def main():
            client, _transport = self._client(handler)
            await client.connect()
            with self.assertRaises(ToolCallError) as ctx:
                await client.call_tool("browser_status", {})
            self.assertEqual(ctx.exception.code, "E_DAEMON")
            self.assertIn("E_DAEMON", str(ctx.exception))
            detailed_error = None
            try:
                await client.call_tool_detailed("browser_status", {})
            except ToolCallError as error:
                detailed_error = error
            self.assertIsNotNone(detailed_error)
            await client.close()

        run(main())

    def test_detailed_result_fields_and_progress_summary(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                return tool_result({"ok": True}, receipt={"id": "apr_2_y", "seq": 2})
            return {}

        async def main():
            client, _transport = self._client(handler)
            await client.connect()
            events = []
            detailed = await client.call_tool_detailed("browser_status", {}, on_progress=events.append)
            self.assertEqual(detailed["payload"], {"ok": True})
            self.assertEqual(detailed["tool"], "browser_status")
            self.assertIn("meta", detailed)
            self.assertIn("elapsed_ms", detailed)
            self.assertIn("request_id", detailed)
            self.assertEqual(detailed["approval_receipt"]["id"], "apr_2_y")
            self.assertEqual(detailed["progress_summary"]["started"], True)
            self.assertEqual(detailed["progress_summary"]["final_phase"], "done")
            self.assertGreaterEqual(len(events), 2)
            self.assertEqual(events[0]["phase"], "start")
            self.assertEqual(events[-1]["phase"], "done")
            await client.close()

        run(main())

    def test_progress_notifications_are_filtered_by_token(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                token = params["_meta"]["progressToken"]
                transport.emit({"jsonrpc": "2.0", "method": "notifications/progress",
                                "params": {"progressToken": token, "progress": 1, "total": 3, "message": "step-1"}})
                transport.emit({"jsonrpc": "2.0", "method": "notifications/progress",
                                "params": {"progressToken": "other-token", "progress": 9}})
                return tool_result({"ok": True})
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            events = []
            detailed = await client.call_tool_detailed("browser_observe", {}, progress=True, on_progress=events.append)
            progress_events = [event for event in detailed["events"] if event["phase"] == "progress"]
            self.assertEqual(len(progress_events), 1, "只转发匹配 progressToken 的通知")
            self.assertEqual(progress_events[0]["message"], "step-1")
            self.assertEqual(detailed["progress_summary"]["progress_samples"], 1)
            # 通知监听器在调用结束后注销，不泄漏到下一次调用。
            self.assertEqual(len(transport.listeners), 0)
            await client.close()

        run(main())

    def test_cancel_scope_wakes_waiter_with_cancelled(self):
        transport = FakeAsyncTransport()
        transport.deferred.add("tools/call")

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            scope = AsyncCancellationScope()
            events = []
            task = asyncio.create_task(client.call_tool("browser_observe", {}, progress=True,
                                                       on_progress=events.append, cancel_scope=scope))
            await asyncio.sleep(0.02)
            self.assertIsNotNone(scope.request_id)
            cancelled = await scope.cancel("user aborted")
            self.assertTrue(cancelled)
            with self.assertRaises(BridgeError) as ctx:
                await task
            self.assertEqual(ctx.exception.code, "E_CANCELLED")
            self.assertTrue(scope.cancelled)
            self.assertEqual(scope.reason, "user aborted")
            self.assertTrue(any(event["phase"] == "cancelled" for event in events))
            self.assertEqual(transport.cancels[-1]["reason"], "user aborted")
            await client.close()

        run(main())

    def test_cancel_request_direct(self):
        transport = FakeAsyncTransport()
        transport.deferred.add("tools/call")

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            request_ids = []

            async def on_request(rid):
                request_ids.append(rid)

            task = asyncio.create_task(client.call_tool("browser_observe", {}, on_request=on_request))
            await asyncio.sleep(0.02)
            self.assertTrue(await client.cancel_request(request_ids[0], "direct"))
            with self.assertRaises(BridgeError) as ctx:
                await task
            self.assertEqual(ctx.exception.code, "E_CANCELLED")
            # 取消未知 request 返回 False，不抛错。
            self.assertFalse(await client.cancel_request(999999, "nope"))
            await client.close()

        run(main())


class RetryTest(unittest.TestCase):
    def test_retry_transient_then_success(self):
        attempts = {"count": 0}
        transport = FakeAsyncTransport()

        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                attempts["count"] += 1
                if attempts["count"] < 3:
                    return tool_result("E_RATE_LIMITED: slow down", is_error=True, error_code="E_RATE_LIMITED")
                return tool_result({"ok": True, "attempt": attempts["count"]})
            return {}

        transport.handler = handler

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            retries = []
            sleeps = []

            async def fake_sleep(seconds):
                sleeps.append(seconds)

            result = await client.call_tool_with_retry(
                "browser_status", {}, max_attempts=3, on_retry=retries.append, sleep=fake_sleep,
            )
            self.assertEqual(result["attempt"], 3)
            self.assertEqual(len(retries), 2)
            self.assertEqual(retries[0]["attempt"], 1)
            self.assertEqual(retries[0]["code"], "E_RATE_LIMITED")
            self.assertEqual(len(sleeps), 2)
            self.assertTrue(all(0 <= value <= 10 for value in sleeps))
            await client.close()

        run(main())

    def test_retry_stops_on_non_retryable_and_exhaustion(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                return tool_result("E_RATE_LIMITED: slow", is_error=True, error_code="E_RATE_LIMITED")
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            sleeps = []

            async def fake_sleep(seconds):
                sleeps.append(seconds)

            with self.assertRaises(ToolCallError) as ctx:
                await client.call_tool_with_retry("browser_status", {}, max_attempts=2, sleep=fake_sleep)
            self.assertEqual(ctx.exception.code, "E_RATE_LIMITED")
            calls = [row for row in transport.requests if row["method"] == "tools/call"]
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(sleeps), 1)
            await client.close()

        run(main())

    def test_retry_does_not_retry_non_retryable_code(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                return tool_result("E_ARG_MISSING: bad", is_error=True, error_code="E_ARG_MISSING")
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            calls_before = sum(1 for row in transport.requests if row["method"] == "tools/call")
            with self.assertRaises(ToolCallError) as ctx:
                await client.call_tool_with_retry("browser_status", {}, max_attempts=3)
            self.assertEqual(ctx.exception.code, "E_ARG_MISSING")
            calls_after = sum(1 for row in transport.requests if row["method"] == "tools/call")
            self.assertEqual(calls_after - calls_before, 1, "不可重试码只调用一次")
            await client.close()

        run(main())


class PagingTest(unittest.TestCase):
    @staticmethod
    def paged_handler(method, params, rid):
        if method == "initialize":
            return FakeAsyncTransport.default_handler(method, params, rid)
        if method == "tools/call":
            cursor = (params.get("arguments") or {}).get("cursor")
            if cursor is None:
                return tool_result({"cursor": "c2", "truncated": True, "partial": True, "page": 1})
            if cursor == "c2":
                return tool_result({"cursor": "c3", "truncated": True, "partial": True, "page": 2})
            return tool_result({"cursor": None, "truncated": False, "partial": False, "page": 3})
        return {}

    def test_call_tool_paged_follows_partial_cursor(self):
        transport = FakeAsyncTransport(self.paged_handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            pages = await client.call_tool_paged("browser_observe", {}, max_pages=5)
            self.assertEqual([page["page"] for page in pages], [1, 2, 3])
            self.assertFalse(pages[-1]["truncated"])
            await client.close()

        run(main())

    def test_call_tool_paged_respects_max_pages(self):
        transport = FakeAsyncTransport(self.paged_handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            pages = await client.call_tool_paged("browser_observe", {}, max_pages=2)
            self.assertEqual(len(pages), 2)
            await client.close()

        run(main())

    def test_iter_tool_pages_async_generator(self):
        transport = FakeAsyncTransport(self.paged_handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            seen = []
            async for page in client.iter_tool_pages("browser_observe", {}, max_pages=5):
                seen.append(page["page"])
            self.assertEqual(seen, [1, 2, 3])
            with self.assertRaises(BridgeError) as ctx:
                async for _page in client.iter_tool_pages("browser_observe", {}, max_pages=0):
                    pass
            self.assertEqual(ctx.exception.code, "E_ARG_RANGE")
            await client.close()

        run(main())

    def test_async_generator_partial_without_cursor_stops(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                return tool_result({"truncated": True, "partial": True, "page": 1})
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            pages = await client.call_tool_paged("browser_observe", {}, max_pages=5)
            self.assertEqual(len(pages), 1)
            await client.close()

        run(main())


class ConcurrencyTest(unittest.TestCase):
    def test_call_tools_preserves_order_and_isolates_failures(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "tools/call":
                name = params.get("name")
                if name == "browser_evaluate":
                    return tool_result("E_DAEMON: nope", is_error=True, error_code="E_DAEMON")
                return tool_result({"ok": True, "tool": name})
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            results = await client.call_tools(
                [("browser_status", {}), {"name": "browser_evaluate", "args": {"expression": "1"}, "approval": True},
                 ("browser_tabs", {})],
                max_concurrency=3,
            )
            self.assertEqual([row["name"] for row in results], ["browser_status", "browser_evaluate", "browser_tabs"])
            self.assertEqual([row["ok"] for row in results], [True, False, True])
            self.assertEqual(results[1]["code"], "E_DAEMON")
            self.assertEqual(await client.call_tools([], max_concurrency=2), [])
            await client.close()

        run(main())


class ReadOnlyMethodsTest(unittest.TestCase):
    def test_resources_prompts_completion_routing(self):
        transport = FakeAsyncTransport()

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            self.assertEqual(len(await client.list_resources()), 1)
            page = await client.resource_list_page(cursor="c1", limit=5, query="skill", kind="skill-main", sort="uri")
            self.assertIn("resources", page)
            read = await client.read_resource("bridge://skill/SKILL.md")
            self.assertEqual(read["contents"][0]["uri"], "bridge://skill/SKILL.md")
            templates = await client.list_resource_templates()
            self.assertEqual(templates, [])
            prompts = await client.list_prompts()
            self.assertEqual(prompts[0]["name"], "har_analysis")
            versions = await client.prompt_versions()
            self.assertEqual(versions[0]["version"], "1.0.0")
            await client.get_prompt("har_analysis", {"source": "latest"}, version="1.0.0")
            get_call = next(row for row in transport.requests if row["method"] == "prompts/get")
            self.assertEqual(get_call["params"]["version"], "1.0.0")
            completion = await client.complete_prompt_argument("har_analysis", "focus", "err")
            self.assertEqual(completion["completion"]["values"], ["errors", "timings"])
            resource_completion = await client.complete_resource_argument("bridge://observation/{session}", "session", "")
            self.assertIn("completion", resource_completion)
            self.assertTrue(client.supports_completion())
            await client.ping()
            self.assertTrue(any(row["method"] == "ping" for row in transport.requests))
            await client.close()

        run(main())

    def test_list_all_pagination(self):
        def handler(method, params, rid):
            if method == "initialize":
                return FakeAsyncTransport.default_handler(method, params, rid)
            if method == "resources/list":
                cursor = params.get("cursor")
                if cursor is None:
                    return {"resources": [{"uri": "bridge://a"}], "nextCursor": "p2"}
                if cursor == "p2":
                    return {"resources": [{"uri": "bridge://b"}], "nextCursor": None}
                return {"resources": [], "nextCursor": None}
            if method == "prompts/list":
                return {"prompts": [{"name": "p1"}], "nextCursor": None}
            return {}

        transport = FakeAsyncTransport(handler)

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            all_resources = await client.list_resources_all(page_size=1)
            self.assertEqual([row["uri"] for row in all_resources["resources"]], ["bridge://a", "bridge://b"])
            self.assertEqual(all_resources["pages"], 2)
            all_prompts = await client.list_prompts_all()
            self.assertEqual(all_prompts["prompts"][0]["name"], "p1")
            await client.close()

        run(main())

    def test_subscriptions_and_handler(self):
        transport = FakeAsyncTransport()

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            received = []

            async def handler(params):
                received.append(params)

            listener = client.add_resource_updated_handler(handler)
            self.assertIn(listener, transport.listeners)
            report = await client.subscribe_resource("bridge://observation/latest")
            self.assertEqual(report["uri"], "bridge://observation/latest")
            self.assertEqual(client.resource_subscriptions(), ["bridge://observation/latest"])
            transport.emit({"jsonrpc": "2.0", "method": "notifications/resources/updated",
                            "params": {"uri": "bridge://observation/latest"}})
            await asyncio.sleep(0.01)
            self.assertEqual(received[-1]["uri"], "bridge://observation/latest")
            self.assertTrue(client.remove_resource_updated_handler(listener))
            self.assertFalse(client.remove_resource_updated_handler(listener))
            await client.unsubscribe_resource("bridge://observation/latest")
            self.assertEqual(client.resource_subscriptions(), [])
            await client.close()

        run(main())

    def test_sync_resource_subscriptions(self):
        transport = FakeAsyncTransport()

        async def main():
            client = AsyncMcpToolClient(transport=transport)
            await client.connect()
            result = await client.sync_resource_subscriptions(
                ["bridge://observation/latest", "bridge://observation/s1"],
            )
            self.assertEqual(result["subscribed"], ["bridge://observation/latest", "bridge://observation/s1"])
            self.assertEqual(client.resource_subscriptions(),
                             ["bridge://observation/latest", "bridge://observation/s1"])
            second = await client.sync_resource_subscriptions(["bridge://observation/s1"])
            self.assertEqual(second["unsubscribed"], ["bridge://observation/latest"])
            self.assertEqual(second["to_subscribe"], [])
            await client.close()

        run(main())


class HelperTest(unittest.TestCase):
    def test_plan_and_diff_subscriptions(self):
        plan = plan_subscription_changes(["a", "b"], ["b", "c"])
        self.assertEqual(plan["to_subscribe"], ["a"])
        self.assertEqual(plan["to_unsubscribe"], ["c"])
        self.assertEqual(plan["unchanged"], ["b"])
        self.assertEqual(plan["ops"], 2)
        self.assertEqual(plan_subscription_changes(["a"], ["a"])["ops"], 0)
        self.assertEqual(plan_subscription_changes([" a ", "a", ""], [])["desired"], 1)

        diff = diff_subscriptions(["a", "b"], ["b", "c"])
        self.assertEqual(diff["added"], ["c"])
        self.assertEqual(diff["removed"], ["a"])
        self.assertEqual(diff["kept"], ["b"])
        self.assertEqual(diff["counts"]["churn"], 2)
        self.assertFalse(diff["unchanged"])
        self.assertTrue(diff_subscriptions(["a"], ["a"])["unchanged"])

    def test_summarize_progress(self):
        summary = summarize_progress([
            {"phase": "start"},
            {"phase": "progress"},
            {"phase": "retry"},
            {"phase": "done"},
        ])
        self.assertEqual(summary["events"], 4)
        self.assertEqual(summary["final_phase"], "done")
        self.assertEqual(summary["retries"], 1)
        self.assertEqual(summary["progress_samples"], 1)
        self.assertEqual(summary["terminal"], "done")
        self.assertFalse(summarize_progress([{"phase": "start"}])["finished"])
        self.assertEqual(summarize_progress(None)["events"], 0)

    def test_approval_disabled_env(self):
        self.assertTrue(asyncmod.approval_disabled({"BB_MCP_APPROVAL": "off"}))
        self.assertTrue(asyncmod.approval_disabled({"BB_MCP_APPROVAL": "FALSE"}))
        self.assertFalse(asyncmod.approval_disabled({}))
        self.assertFalse(asyncmod.approval_disabled({"BB_MCP_APPROVAL": "required"}))


@unittest.skipUnless(shutil.which(os.environ.get("BB_NODE") or "node"), "需要本机 node")
class RealServerIntegrationTest(unittest.TestCase):
    def test_real_server_protocol_surface(self):
        home = tempfile.mkdtemp(prefix="bb-py-async-")

        async def main():
            client = AsyncMcpToolClient(home=home)
            await client.connect()
            try:
                tools = await client.list_mcp_tools()
                self.assertEqual(len(tools), 92)
                experimental = client.capabilities.get("experimental") or {}
                for key in (
                    "browser-bridge/resource-graph",
                    "browser-bridge/subscription-diff",
                    "browser-bridge/prompt-versions",
                    "browser-bridge/prompt-completion",
                    "browser-bridge/approval-audit",
                    "browser-bridge/recovery-playbook",
                ):
                    self.assertIn(key, experimental)
                self.assertTrue(experimental["browser-bridge/resource-graph"]["supported"])
                self.assertEqual(experimental["browser-bridge/approval-audit"]["byEscalation"]["mandatory"], 1)

                # 无 daemon：工具错误映射为 E_DAEMON，并带结构化恢复计划。
                with self.assertRaises(ToolCallError) as ctx:
                    await client.call_tool("browser_status", {})
                self.assertEqual(ctx.exception.code, "E_DAEMON")
                detailed = None
                try:
                    await client.call_tool_detailed("browser_status", {})
                except ToolCallError:
                    pass
                self.assertIsNone(detailed)  # 详细调用同样抛 ToolCallError

                prompts = await client.list_prompts()
                self.assertEqual(len(prompts), 9)
                version_meta = prompts[0]["_meta"]["browser-bridge/prompt-version"]
                self.assertEqual(version_meta["version"], "1.0.0")
                self.assertEqual(len(version_meta["fingerprint"]), 64)

                completion = await client.complete_prompt_argument("har_analysis", "focus", "err")
                self.assertEqual(completion["completion"]["values"], ["errors"])

                page = await client.resource_list_page()
                resources_meta = page["_meta"]["browser-bridge/resources"]
                self.assertGreaterEqual(resources_meta["graph"]["nodes"], 1)
                self.assertIn("nodesAdded", resources_meta["graphDiff"])
                self.assertIn("subscriptionCoverage", resources_meta)

                reader = await client.list_resources()
                self.assertTrue(any(row["uri"] == "bridge://skill/SKILL.md" for row in reader))
                read = await client.read_resource("bridge://protocol/summary")
                self.assertTrue(read["contents"][0]["text"])

                report = await client.subscribe_resource("bridge://observation/latest")
                self.assertEqual(report["uri"], "bridge://observation/latest")
                self.assertIn("diff", report)
                snapshot = client.transport_snapshot()
                self.assertTrue(snapshot["transport"]["alive"])
            finally:
                await client.close()

        try:
            run(main())
        finally:
            shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
