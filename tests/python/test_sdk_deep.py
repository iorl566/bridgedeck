"""tests/python/test_sdk_deep.py —— Python SDK 深化能力的单元测试（不需要 node / 浏览器）。

覆盖第十批-B 的 Python 侧新增面：
  - 错误恢复映射：error_family / classify_error_code / audit_error_map；
  - 重试：retry_delay_ms 的确定性抖动、retry_plan 的 transient/after-action/不可重试判定、
    call_tool_with_retry 的实际重试次数与 on_retry 回调；
  - call_tool_detailed：payload/meta/elapsed_ms/request_id/events；
  - ProgressTracker：阶段序列、单一终态不变式、非法序列抛 E_PROGRESS_SEQUENCE；
  - CancellationScope：attach/cancel/cancel_after/回调/幂等，以及与 call_tool 的集成；
  - 分页：iter_tool_pages 生成器、list_resources_all / list_prompts_all；
  - completion：complete / complete_prompt_argument / supports_completion；
  - 并发：call_tools 保持输入顺序、单点失败不拖垮其它调用；
  - 覆盖审计：tool_coverage 全 92 工具无缺项。
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    NON_RETRYABLE_CODES,
    RETRY_POLICY,
    TERMINAL_CODES,
    BridgeError,
    CancellationScope,
    McpToolClient,
    ProgressTracker,
    ToolCallError,
    audit_error_map,
    classify_error_code,
    error_family,
    is_retryable,
    needs_action_before_retry,
    recovery_for,
    retry_delay_ms,
    retry_plan,
    tool_coverage,
)


def tool_result(payload, is_error=False, error_code=None, extra_meta=None):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    meta = {"browser-bridge/tier": "read", "browser-bridge/elapsedMs": 1}
    if error_code:
        meta["browser-bridge/errorCode"] = error_code
    if extra_meta:
        meta.update(extra_meta)
    return {"content": [{"type": "text", "text": text}], "isError": bool(is_error), "_meta": meta}


class FakeTransport:
    """可注入传输：记录请求、按 handler 返回；支持 request(on_start=) 与 cancel。"""

    def __init__(self, handler=None):
        self.handler = handler or (lambda method, params, timeout: {})
        self.requests = []
        self.notifications = []
        self.listeners = []
        self.cancels = []
        self.closed = False

    def request(self, method, params=None, timeout=None, on_start=None):
        self.requests.append({"method": method, "params": params, "timeout": timeout})
        request_id = len(self.requests)
        if on_start is not None:
            on_start(request_id)
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
        for listener in list(self.listeners):
            listener(message)

    def cancel(self, request_id, reason=""):
        self.cancels.append({"request_id": request_id, "reason": reason})
        return True

    def close(self):
        self.closed = True


def make_client(handler):
    transport = FakeTransport(handler)
    client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-deep-"), transport=transport)
    client.connected = True
    client.capabilities = {"resources": {"subscribe": True, "listPagination": {"cursorParam": "cursor"}}, "completions": {}}
    return client, transport


class ErrorMapTest(unittest.TestCase):
    def test_families(self):
        cases = {
            "E_ARG_MISSING": "validation",
            "E_ARG_TYPE": "validation",
            "E_HUMAN_GATE": "approval",
            "E_CANCELLED": "cancellation",
            "E_REQUEST_CANCELLED": "cancellation",
            "E_TIMEOUT": "timeout",
            "E_DAEMON": "transport",
            "E_NO_SESSION": "session",
            "E_SESSION_STOPPED": "session",
            "E_LEDGER_IO": "ledger",
            "E_NOT_FOUND": "resource",
            "E_STALE_REF": "resource",
            "E_PROTOCOL_UNSUPPORTED": "protocol",
            "E_INTERNAL": "internal",
        }
        for code, expected in cases.items():
            self.assertEqual(error_family(code), expected, code)
        self.assertEqual(error_family("E_MADE_UP"), "unknown")

    def test_classify_error_code_shape(self):
        classification = classify_error_code("E_NOT_FOUND")
        self.assertEqual(classification["code"], "E_NOT_FOUND")
        self.assertEqual(classification["category"], "resource")
        self.assertEqual(classification["retry"], "after-action")
        self.assertEqual(classification["json_rpc_code"], -32002)
        self.assertFalse(classification["terminal"])
        self.assertTrue(classification["known_family"])

        unknown = classify_error_code("E_MADE_UP")
        self.assertEqual(unknown["category"], "unknown")
        self.assertEqual(unknown["retry"], "no")
        self.assertEqual(unknown["json_rpc_code"], -32603)

        # 终端/不可重试集合与 Node 侧同名常量一致
        for code in TERMINAL_CODES:
            self.assertIn(code, NON_RETRYABLE_CODES)
            self.assertEqual(classify_error_code(code)["terminal"], True)

    def test_recovery_for_matches_partial_table(self):
        self.assertEqual(recovery_for("E_STALE_REF"), ("after-action", "ref 已失效：重新 observe"))
        self.assertEqual(recovery_for("E_MADE_UP"), ("no", ""))

    def test_retry_delay_deterministic_and_bounded(self):
        first = retry_delay_ms(0, code="E_TIMEOUT")
        second = retry_delay_ms(0, code="E_TIMEOUT")
        self.assertEqual(first, second)
        self.assertGreaterEqual(first, int(250 * 0.85) - 1)
        self.assertLessEqual(first, int(250 * 1.15) + 1)
        self.assertNotEqual(retry_delay_ms(0, code="E_TIMEOUT"), retry_delay_ms(0, code="E_RATE_LIMITED"))
        for attempt in range(20):
            delay = retry_delay_ms(attempt, code="E_TIMEOUT")
            self.assertGreaterEqual(delay, 0)
            self.assertLessEqual(delay, RETRY_POLICY["max_delay_ms"])
        self.assertEqual(retry_delay_ms(0, code="x", jitter=False), 250)
        self.assertEqual(retry_delay_ms(3, code="x", jitter=False), 2000)

    def test_retry_plan_modes(self):
        transient = retry_plan("E_RATE_LIMITED", attempt=1, max_attempts=3)
        self.assertTrue(transient["retryable"])
        self.assertGreater(transient["delay_ms"], 0)
        self.assertEqual(transient["reason"], "retryable-transient")
        self.assertEqual(transient["category"], "session")

        exhausted = retry_plan("E_RATE_LIMITED", attempt=3, max_attempts=3)
        self.assertFalse(exhausted["retryable"])
        self.assertEqual(exhausted["delay_ms"], 0)
        self.assertEqual(exhausted["reason"], "attempts-exhausted")

        needs_action = retry_plan("E_STALE_REF", attempt=1)
        self.assertFalse(needs_action["retryable"])
        self.assertTrue(needs_action["needs_action"])
        self.assertEqual(needs_action["reason"], "needs-action")

        blocked = retry_plan("E_HUMAN_GATE", attempt=1)
        self.assertFalse(blocked["retryable"])
        self.assertEqual(blocked["reason"], "non-retryable-code")

        self.assertFalse(is_retryable("E_CANCELLED"))
        self.assertTrue(needs_action_before_retry("E_OBSERVATION_STALE"))
        self.assertFalse(needs_action_before_retry("E_RATE_LIMITED"))

    def test_audit_error_map(self):
        report = audit_error_map()
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual(report["errors"], [])
        self.assertIn("approval", report["families"])


class RetryCallTest(unittest.TestCase):
    def test_call_tool_with_retry_retries_transient_then_succeeds(self):
        attempts = {"count": 0}

        def handler(method, params, timeout):
            if method != "tools/call":
                return {}
            attempts["count"] += 1
            if attempts["count"] < 3:
                return tool_result("E_RATE_LIMITED: 被限流", is_error=True, error_code="E_RATE_LIMITED")
            return tool_result({"observation": "@e1 ok"})

        client, transport = make_client(handler)
        retries = []
        result = client.call_tool_with_retry(
            "browser_observe", {}, max_attempts=3, on_retry=retries.append,
        )
        self.assertEqual(attempts["count"], 3)
        self.assertEqual(result["observation"], "@e1 ok")
        self.assertEqual(len(retries), 2)
        self.assertEqual(retries[0]["tool"], "browser_observe")
        self.assertGreater(retries[0]["delay_ms"], 0)
        self.assertEqual(len(transport.requests), 3)

    def test_call_tool_with_retry_does_not_retry_non_retryable(self):
        def handler(method, params, timeout):
            return tool_result("E_HUMAN_GATE: 需要确认", is_error=True, error_code="E_HUMAN_GATE")

        client, transport = make_client(handler)
        # 审批错误在本地闸门就被拦下（默认 BB_MCP_APPROVAL 未开启时不拦），
        # 因此这里用 browser_evaluate + approval=True 让请求真正到达 transport。
        with self.assertRaises(ToolCallError) as caught:
            client.call_tool_with_retry(
                "browser_evaluate", {"expression": "1"}, approval=True, max_attempts=5,
            )
        self.assertEqual(caught.exception.code, "E_HUMAN_GATE")
        self.assertEqual(len(transport.requests), 1, "不可重试错误只应调用一次")

    def test_call_tool_retry_true_uses_default_attempts(self):
        attempts = {"count": 0}

        def handler(method, params, timeout):
            attempts["count"] += 1
            if attempts["count"] < RETRY_POLICY["max_attempts"]:
                return tool_result("E_RATE_LIMITED: busy", is_error=True, error_code="E_RATE_LIMITED")
            return tool_result({"ok": True})

        client, _transport = make_client(handler)
        self.assertEqual(client.call_tool("browser_observe", {}, retry=True), {"ok": True})
        self.assertEqual(attempts["count"], RETRY_POLICY["max_attempts"])

    def test_call_tool_detailed_returns_meta_and_events(self):
        def handler(method, params, timeout):
            return tool_result({"observation": "@e1"}, extra_meta={"browser-bridge/snapshot": {"kind": "observation"}})

        client, _transport = make_client(handler)
        progress = []
        request_ids = []
        detail = client.call_tool_detailed(
            "browser_observe", {},
            on_progress=progress.append,
            on_request=request_ids.append,
        )
        self.assertEqual(detail["payload"]["observation"], "@e1")
        self.assertEqual(detail["meta"]["browser-bridge/snapshot"]["kind"], "observation")
        self.assertGreaterEqual(detail["elapsed_ms"], 0)
        self.assertEqual(detail["tool"], "browser_observe")
        self.assertEqual(detail["tier"], "read")
        self.assertEqual([event["phase"] for event in detail["events"]], ["start", "done"])
        self.assertEqual(len(progress), 2)
        self.assertIsInstance(detail["request_id"], int)
        self.assertEqual(request_ids, [detail["request_id"]])


class ProgressTrackerTest(unittest.TestCase):
    def test_happy_path(self):
        tracker = ProgressTracker()
        handler = tracker.handler()
        handler({"phase": "start", "tool": "browser_observe"})
        handler({"phase": "progress", "progress": 1})
        handler({"phase": "progress", "progress": 2})
        handler({"phase": "done", "elapsed_ms": 12})
        summary = tracker.summary()
        self.assertEqual(summary["events"], 4)
        self.assertEqual(summary["progress_samples"], 2)
        self.assertTrue(summary["saw_start"])
        self.assertTrue(summary["saw_done"])
        self.assertTrue(summary["single_terminal"])
        self.assertTrue(summary["valid"])
        self.assertEqual(summary["final_phase"], "done")
        self.assertEqual(tracker.assert_valid(), summary)

    def test_invalid_sequences(self):
        tracker = ProgressTracker()
        tracker.events.append({"phase": "done"})
        tracker.events.append({"phase": "error"})
        summary = tracker.summary()
        self.assertFalse(summary["single_terminal"])
        self.assertFalse(summary["valid"])
        with self.assertRaises(BridgeError) as caught:
            tracker.assert_valid()
        self.assertEqual(caught.exception.code, "E_INTERNAL")
        self.assertIn("进度事件序列非法", str(caught.exception))

    def test_extra_sinks_and_failing_sink(self):
        tracker = ProgressTracker()
        received = []

        def sink(event):
            received.append(event)
            raise RuntimeError("UI 回调炸了也不影响工具")

        tracker.handler(sink)({"phase": "start"})
        self.assertEqual(len(received), 1)
        self.assertEqual(len(tracker), 1)


class CancellationScopeTest(unittest.TestCase):
    def test_cancel_is_idempotent_and_runs_callbacks(self):
        scope = CancellationScope()
        reasons = []
        scope.add_callback(reasons.append)
        self.assertFalse(scope.cancelled)
        self.assertTrue(scope.cancel("first"))
        self.assertFalse(scope.cancel("second"))
        self.assertTrue(scope.cancelled)
        self.assertEqual(scope.reason, "first")
        self.assertEqual(reasons, ["first"])

    def test_attach_after_cancel_forwards_immediately(self):
        scope = CancellationScope()
        scope.cancel("early")
        forwarded = []
        scope.attach(7, lambda request_id, reason: forwarded.append((request_id, reason)))
        self.assertEqual(forwarded, [(7, "early")])

    def test_attach_then_cancel_forwards_once(self):
        scope = CancellationScope()
        forwarded = []
        scope.attach(9, lambda request_id, reason: forwarded.append((request_id, reason)))
        scope.cancel("later")
        scope.cancel("again")
        self.assertEqual(forwarded, [(9, "later")])
        scope.detach()

    def test_cancel_after_timer(self):
        scope = CancellationScope()
        scope.cancel_after(0.05, reason="timeout")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not scope.cancelled:
            time.sleep(0.01)
        self.assertTrue(scope.cancelled)
        self.assertEqual(scope.reason, "timeout")
        scope.dispose()

    def test_cancel_scope_integrates_with_call_tool(self):
        """真实取消路径：请求阻塞 → 定时器触发 scope.cancel → transport.cancel → E_CANCELLED。"""

        class BlockingTransport(FakeTransport):
            def __init__(self):
                super().__init__()
                self.release = threading.Event()
                self.cancelled_ids = []

            def request(self, method, params=None, timeout=None, on_start=None):
                self.requests.append({"method": method, "params": params, "timeout": timeout})
                request_id = len(self.requests)
                if on_start is not None:
                    on_start(request_id)
                if not self.release.wait(3.0):
                    raise BridgeError("E_TIMEOUT", "测试传输超时")
                raise BridgeError("E_CANCELLED", "已被取消")

            def cancel(self, request_id, reason=""):
                self.cancelled_ids.append((request_id, reason))
                self.release.set()
                return True

        transport = BlockingTransport()
        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-scope-"), transport=transport)
        client.connected = True
        scope = CancellationScope()
        progress = []
        scope.cancel_after(0.08, reason="sdk-test")
        with self.assertRaises(BridgeError) as caught:
            client.call_tool("browser_observe", {}, cancel_scope=scope, on_progress=progress.append)
        self.assertEqual(caught.exception.code, "E_CANCELLED")
        self.assertEqual(len(transport.cancelled_ids), 1)
        self.assertEqual(transport.cancelled_ids[0][1], "sdk-test")
        self.assertEqual([event["phase"] for event in progress], ["start", "cancelled"])
        scope.dispose()


class PaginationAndCompletionTest(unittest.TestCase):
    def test_iter_tool_pages_stops_at_cursor_end(self):
        pages = [
            {"observation": "@e1", "cursor": "c2"},
            {"observation": "@e2", "cursor": "c3"},
            {"observation": "@e3", "cursor": None},
        ]
        state = {"index": 0}

        def handler(method, params, timeout):
            payload = pages[min(state["index"], len(pages) - 1)]
            state["index"] += 1
            return tool_result(payload)

        client, _transport = make_client(handler)
        collected = list(client.iter_tool_pages("browser_observe", {}, max_pages=5))
        self.assertEqual([page["observation"] for page in collected], ["@e1", "@e2", "@e3"])
        self.assertEqual(state["index"], 3)

    def test_iter_tool_pages_respects_max_pages(self):
        def handler(method, params, timeout):
            return tool_result({"observation": "@e1", "cursor": "always-more"})

        client, _transport = make_client(handler)
        collected = list(client.iter_tool_pages("browser_observe", {}, max_pages=2))
        self.assertEqual(len(collected), 2)

    def test_iter_tool_pages_rejects_bad_max_pages(self):
        client, _transport = make_client(lambda *args: tool_result({"ok": True}))
        with self.assertRaises(BridgeError) as caught:
            list(client.iter_tool_pages("browser_observe", {}, max_pages=0))
        self.assertEqual(caught.exception.code, "E_ARG_RANGE")

    def test_list_resources_all_follows_next_cursor(self):
        calls = []

        def handler(method, params, timeout):
            calls.append(params)
            if method != "resources/list":
                return {}
            if params.get("cursor") == "bb1.resources.2":
                return {"resources": [{"uri": "bridge://c"}], "_meta": {}}
            return {"resources": [{"uri": "bridge://a"}, {"uri": "bridge://b"}], "nextCursor": "bb1.resources.2"}

        client, _transport = make_client(handler)
        result = client.list_resources_all(page_size=2)
        self.assertEqual([row["uri"] for row in result["resources"]], ["bridge://a", "bridge://b", "bridge://c"])
        self.assertEqual(result["pages"], 2)
        self.assertIsNone(result["next_cursor"])
        self.assertEqual(calls[0]["limit"], 2)
        self.assertEqual(calls[1]["cursor"], "bb1.resources.2")

    def test_list_prompts_all_follows_pages(self):
        def handler(method, params, timeout):
            if method != "prompts/list":
                return {}
            if params.get("cursor"):
                return {"prompts": [{"name": "p3"}]}
            return {"prompts": [{"name": "p1"}, {"name": "p2"}], "nextCursor": "bb1.prompts.2"}

        client, _transport = make_client(handler)
        result = client.list_prompts_all(page_size=2)
        self.assertEqual([row["name"] for row in result["prompts"]], ["p1", "p2", "p3"])
        self.assertEqual(result["pages"], 2)

    def test_complete_helpers(self):
        seen = []

        def handler(method, params, timeout):
            seen.append((method, params))
            if method == "completion/complete":
                return {"completion": {"values": ["errors"], "total": 1, "hasMore": False}}
            return {}

        client, _transport = make_client(handler)
        self.assertTrue(client.supports_completion())
        self.assertTrue(client.supports_list_pagination())

        values = client.complete_prompt_argument("har_analysis", "focus", "err")
        self.assertEqual(values["values"], ["errors"])
        self.assertEqual(seen[-1][0], "completion/complete")
        self.assertEqual(seen[-1][1]["ref"], {"type": "ref/prompt", "name": "har_analysis"})
        self.assertEqual(seen[-1][1]["argument"], {"name": "focus", "value": "err"})

        client.complete_resource_argument("bridge://skill/references/{name}", "name", "")
        self.assertEqual(seen[-1][1]["ref"]["type"], "ref/resource")

        client.complete({"type": "ref/prompt", "name": "x"}, {"name": "y", "value": ""}, cursor="bb1.completion.1", limit=10)
        self.assertEqual(seen[-1][1]["cursor"], "bb1.completion.1")
        self.assertEqual(seen[-1][1]["limit"], 10)

    def test_supports_completion_false_on_old_server(self):
        client, _transport = make_client(lambda *args: {})
        client.capabilities = {"resources": {}}
        self.assertFalse(client.supports_completion())
        self.assertFalse(client.supports_list_pagination())


class ConcurrencyAndCoverageTest(unittest.TestCase):
    def test_call_tools_preserves_order_and_isolates_failures(self):
        def handler(method, params, timeout):
            name = params.get("name")
            if name == "browser_status":
                return tool_result({"ok": True})
            if name == "browser_audit":
                return tool_result("E_NOT_FOUND: 没有审计记录", is_error=True, error_code="E_NOT_FOUND")
            return tool_result({"name": name})

        client, _transport = make_client(handler)
        results = client.call_tools(
            [("browser_status", {}), ("browser_audit", {}), ("browser_observe", {}), ("browser_tabs", {})],
            max_workers=3,
        )
        self.assertEqual([row["name"] for row in results], ["browser_status", "browser_audit", "browser_observe", "browser_tabs"])
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])
        self.assertEqual(results[1]["code"], "E_NOT_FOUND")
        self.assertTrue(results[2]["ok"])
        self.assertTrue(results[3]["ok"])

    def test_call_tools_accepts_dict_specs(self):
        def handler(method, params, timeout):
            return tool_result({"ok": True})

        client, _transport = make_client(handler)
        results = client.call_tools([{"name": "browser_status", "args": {}}], max_workers=1)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]["ok"])

    def test_tool_coverage_is_complete(self):
        coverage = tool_coverage()
        self.assertEqual(coverage["total"], 92)
        self.assertEqual(coverage["covered"], 92)
        self.assertEqual(coverage["missing"], [])
        self.assertEqual(coverage["spec_errors"], [])
        self.assertTrue(coverage["complete"])
        self.assertEqual(coverage["by_tier"], {"read": 36, "mutate": 49, "destructive": 7})
        self.assertEqual(len(coverage["approvals"]), 7)
        self.assertEqual(len(coverage["paginated"]), 8)
        self.assertEqual(coverage, tool_coverage())


if __name__ == "__main__":
    unittest.main()
