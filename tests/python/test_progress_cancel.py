"""tests/python/test_progress_cancel.py —— Python SDK 的 MCP 进度通知与取消面单测。

覆盖（不需要 node / 浏览器）：
  - progress=True 才在 tools/call 的 _meta 带 progressToken（默认保持旧行为）；
  - server notifications/progress 按 progressToken 过滤后回调成 phase="progress"；
  - 回调顺序 start → progress... → done，且结束/异常时注销监听器；
  - on_request(request_id) + cancel_request() 从其他线程取消，抛 E_CANCELLED 并补 cancelled 事件；
  - call_tool_paged 透传 progress/on_request；
  - 真实 StdioMcpTransport：通知分发、on_start 回调、cancel 发送 notifications/cancelled 并唤醒等待方。
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
    BridgeError,
    McpToolClient,
    StdioMcpTransport,
    ToolCallError,
)


def tool_result(payload, is_error=False, error_code=None):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    meta = {"browser-bridge/tier": "read", "browser-bridge/elapsedMs": 1}
    if error_code:
        meta["browser-bridge/errorCode"] = error_code
    return {"content": [{"type": "text", "text": text}], "isError": bool(is_error), "_meta": meta}


class ProgressTransport:
    """支持通知监听与 on_start 的 fake transport：请求时同步回放若干 progress 通知。"""

    def __init__(self, result=None, notifications=None):
        self.handler = None
        self.result = result if result is not None else tool_result({"observation": "@e1 ok", "refs": 1})
        self.notifications = notifications
        self.requests = []
        self.listeners = []
        self.on_start_calls = []
        self.started_ids = []
        self.closed = False

    def add_notification_handler(self, handler):
        self.listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler):
        for index, listener in enumerate(self.listeners):
            if listener is handler:
                del self.listeners[index]
                return True
        return False

    def request(self, method, params=None, timeout=None, on_start=None):
        self.requests.append({"method": method, "params": params, "timeout": timeout})
        if on_start is not None:
            self.on_start_calls.append(True)
            on_start(101)
        if method == "tools/call":
            token = ((params or {}).get("_meta") or {}).get("progressToken")
            for row in self.notifications or []:
                message = {
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": dict(row),
                }
                if token is not None and "progressToken" not in message["params"]:
                    message["params"]["progressToken"] = token
                for listener in list(self.listeners):
                    listener(message)
        return self.result

    def notify(self, method, params=None):
        self.requests.append({"method": method, "params": params, "timeout": None})

    def cancel(self, request_id, reason=""):
        self.started_ids.append((request_id, reason))
        return True

    def close(self):
        self.closed = True

    def last(self):
        return self.requests[-1]


class BlockingTransport:
    """request 阻塞直到 cancel()；用于验证 E_CANCELLED 路径与进度收尾事件。"""

    def __init__(self, result=None, ignore_cancel=False):
        self.result = result if result is not None else tool_result({"ok": True})
        self.ignore_cancel = ignore_cancel
        self.started = threading.Event()
        self.cancelled = threading.Event()
        self.cancel_reason = None
        self.request_id = None
        self.listeners = []
        self.requests = []

    def add_notification_handler(self, handler):
        self.listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler):
        for index, listener in enumerate(self.listeners):
            if listener is handler:
                del self.listeners[index]
                return True
        return False

    def request(self, method, params=None, timeout=None, on_start=None):
        self.requests.append({"method": method, "params": params, "timeout": timeout})
        self.request_id = 77
        self.started.set()
        if on_start is not None:
            on_start(self.request_id)
        self.cancelled.wait(timeout=5.0)
        if self.ignore_cancel:
            return self.result
        raise BridgeError("E_CANCELLED", "MCP tools/call 已被取消")

    def cancel(self, request_id, reason=""):
        if request_id != self.request_id:
            return False
        self.cancel_reason = reason
        self.cancelled.set()
        return True

    def notify(self, method, params=None):
        self.requests.append({"method": method, "params": params, "timeout": None})

    def close(self):
        pass


def make_client(transport, name="bb-py-progress-"):
    home = tempfile.mkdtemp(prefix=name)
    return McpToolClient(home=home, transport=transport)


class ProgressTokenTest(unittest.TestCase):
    def test_default_keeps_legacy_shape_without_meta(self):
        transport = ProgressTransport()
        client = make_client(transport)
        events = []
        client.call_tool("browser_observe", {"max_tokens": 500}, on_progress=events.append)
        self.assertNotIn("_meta", transport.last()["params"])
        self.assertEqual([event["phase"] for event in events], ["start", "done"])

    def test_progress_true_adds_token(self):
        transport = ProgressTransport()
        client = make_client(transport)
        events = []
        client.call_tool("browser_observe", {}, progress=True, on_progress=events.append)
        meta = transport.last()["params"]["_meta"]
        self.assertTrue(meta["progressToken"].startswith("bb-"))
        self.assertLessEqual(len(meta["progressToken"]), 128)
        self.assertEqual(meta["progressToken"], transport.last()["params"]["_meta"]["progressToken"])

    def test_progress_token_without_callback_still_sent(self):
        transport = ProgressTransport()
        client = make_client(transport)
        payload = client.call_tool("browser_observe", {}, progress=True)
        self.assertEqual(payload["refs"], 1)
        self.assertIn("progressToken", transport.last()["params"]["_meta"])

    def test_approval_and_progress_share_meta(self):
        transport = ProgressTransport(result=tool_result({"value": 2}))
        client = make_client(transport)
        client.call_tool("browser_evaluate", {"expression": "1 + 1"}, approval=True, progress=True)
        meta = transport.last()["params"]["_meta"]
        self.assertEqual(meta["browser-bridge/approval"], "confirmed")
        self.assertIn("progressToken", meta)

    def test_server_progress_notifications_forwarded_after_start(self):
        notifications = [
            {"progress": 0, "message": "browser_observe 开始执行（观察/读取）"},
            {"progress": 400, "message": "browser_observe 运行中（400ms）"},
            {"progress": 800, "message": "browser_observe 运行中（800ms）"},
            {"progressToken": "someone-else", "progress": 9, "message": "不应出现"},
        ]
        transport = ProgressTransport()
        transport.notifications = notifications
        client = make_client(transport)
        events = []
        client.call_tool("browser_observe", {}, progress=True, on_progress=events.append)
        phases = [event["phase"] for event in events]
        self.assertEqual(phases, ["start", "progress", "progress", "progress", "done"])
        progress_events = [event for event in events if event["phase"] == "progress"]
        self.assertEqual([event["progress"] for event in progress_events], [0, 400, 800])
        self.assertTrue(all(event["tool"] == "browser_observe" for event in progress_events))
        self.assertTrue(all(event["tier"] == "read" for event in progress_events))
        self.assertIn("运行中", progress_events[1]["message"])
        # 其他 progressToken 的通知不得混入
        self.assertNotIn(9, [event.get("progress") for event in progress_events])
        # 结束调用后监听器注销，避免泄漏
        self.assertEqual(transport.listeners, [])

    def test_listener_removed_even_on_tool_error(self):
        transport = ProgressTransport(result=tool_result("E_DAEMON: daemon 未运行", is_error=True, error_code="E_DAEMON"))
        client = make_client(transport)
        events = []
        with self.assertRaises(ToolCallError):
            client.call_tool("browser_observe", {}, progress=True, on_progress=events.append)
        self.assertEqual(events[-1]["phase"], "error")
        self.assertEqual(transport.listeners, [])

    def test_listener_removed_on_transport_error(self):
        class FailingTransport(ProgressTransport):
            def request(self, method, params=None, timeout=None, on_start=None):
                self.requests.append({"method": method, "params": params, "timeout": timeout})
                if on_start is not None:
                    on_start(1)
                raise BridgeError("E_TIMEOUT", "MCP tools/call 超过 1s 未返回")

        transport = FailingTransport()
        client = make_client(transport)
        with self.assertRaises(BridgeError):
            client.call_tool("browser_observe", {}, progress=True, on_progress=lambda event: None)
        self.assertEqual(transport.listeners, [])

    def test_call_tool_paged_forwards_progress(self):
        class PagedTransport(ProgressTransport):
            def __init__(self):
                super().__init__()
                self.calls = 0

            def request(self, method, params=None, timeout=None, on_start=None):
                self.requests.append({"method": method, "params": params, "timeout": timeout})
                if on_start is not None:
                    on_start(200 + self.calls)
                self.calls += 1
                cursor = (params or {}).get("arguments", {}).get("cursor")
                if cursor is None:
                    return tool_result({"observation": "@e1", "cursor": "c2"})
                return tool_result({"observation": "@e2", "cursor": None})

        transport = PagedTransport()
        client = make_client(transport)
        events = []
        pages = client.call_tool_paged("browser_observe", {}, max_pages=5, progress=True, on_progress=events.append)
        self.assertEqual([page["observation"] for page in pages], ["@e1", "@e2"])
        tokens = [request["params"]["_meta"]["progressToken"] for request in transport.requests]
        self.assertEqual(len(tokens), 2)
        self.assertNotEqual(tokens[0], tokens[1], "每页调用应使用独立进度令牌")
        phases = [event["phase"] for event in events]
        self.assertEqual(phases.count("done"), 2)


class CancelTest(unittest.TestCase):
    def test_cancel_request_runs_from_another_thread(self):
        transport = BlockingTransport()
        client = make_client(transport)
        events = []
        captured = {}
        result = {}

        def on_request(request_id):
            captured["id"] = request_id
            self.assertTrue(transport.started.wait(timeout=5.0))
            result["cancelled"] = client.cancel_request(request_id, "用户按下停止")

        def worker():
            try:
                client.call_tool("browser_observe", {}, progress=True, on_progress=events.append, on_request=on_request)
            except BridgeError as error:
                result["error"] = error

        thread = threading.Thread(target=worker, name="bb-cancel-test", daemon=True)
        thread.start()
        thread.join(timeout=8.0)
        self.assertFalse(thread.is_alive(), "取消后调用方不应继续阻塞")
        self.assertEqual(captured["id"], 77)
        self.assertTrue(result.get("cancelled"))
        error = result["error"]
        self.assertEqual(error.code, "E_CANCELLED")
        self.assertIn("已被取消", error.message)
        self.assertEqual(transport.cancel_reason, "用户按下停止")
        phases = [event["phase"] for event in events]
        self.assertEqual(phases[-1], "cancelled")
        self.assertIn("start", phases)

    def test_cancel_request_unknown_returns_false(self):
        transport = BlockingTransport()
        client = make_client(transport)
        self.assertFalse(client.cancel_request(999, "晚到"))

    def test_cancel_request_is_delegated_and_non_fatal(self):
        transport = ProgressTransport(result=tool_result({"ok": True}))
        client = make_client(transport)
        client.call_tool("browser_observe", {}, on_request=lambda request_id: None)
        # fake transport 的 cancel 恒返回 True，仅验证调用被委托且不抛异常。
        self.assertTrue(client.cancel_request(999, "x"))
        self.assertEqual(transport.started_ids, [(999, "x")])
        self.assertEqual(client.call_tool("browser_status", {}), {"ok": True})

    def test_transport_without_cancel_support_returns_false(self):
        class MinimalTransport:
            def request(self, method, params=None, timeout=None):
                return tool_result({"ok": True})

            def notify(self, method, params=None):
                pass

            def close(self):
                pass

        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-min-"), transport=MinimalTransport())
        self.assertFalse(client.cancel_request(1, "x"))

    def test_ignore_cancel_keeps_running_and_returns_result(self):
        transport = BlockingTransport(ignore_cancel=True)
        client = make_client(transport)
        result = {}
        released = threading.Event()

        def on_request(request_id):
            self.assertTrue(transport.started.wait(timeout=5.0))
            client.cancel_request(request_id, "但服务端继续")
            transport.cancelled.set()
            released.set()

        def worker():
            try:
                result["value"] = client.call_tool("browser_observe", {}, on_request=on_request)
            except BridgeError as error:  # pragma: no cover - 不应发生
                result["error"] = error

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(released.wait(timeout=5.0))
        thread.join(timeout=5.0)
        self.assertEqual(result.get("value"), {"ok": True})


class StdioTransportProgressTest(unittest.TestCase):
    def _spawn(self, code, timeout=5.0):
        transport = StdioMcpTransport([sys.executable, "-c", code], timeout=timeout)
        self.addCleanup(transport.close)
        return transport

    def test_notification_handler_receives_progress_and_result(self):
        code = (
            "import json, sys\n"
            "req = json.loads(sys.stdin.readline())\n"
            "print(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/progress',"
            " 'params': {'progressToken': 'tok-1', 'progress': 10, 'message': 'hi'}}), flush=True)\n"
            "print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': {'ok': True}}), flush=True)\n"
            "sys.stdin.readline()\n"
        )
        transport = self._spawn(code)
        received = []
        handler = received.append
        transport.add_notification_handler(handler)
        result = transport.request("tools/call", {}, timeout=3.0)
        self.assertEqual(result, {"ok": True})
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0]["method"], "notifications/progress")
        self.assertEqual(received[0]["params"]["progressToken"], "tok-1")
        self.assertTrue(transport.remove_notification_handler(handler))

    def test_on_start_receives_request_id(self):
        code = (
            "import json, sys\n"
            "req = json.loads(sys.stdin.readline())\n"
            "print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': {'id': req['id']}}), flush=True)\n"
            "sys.stdin.readline()\n"
        )
        transport = self._spawn(code)
        seen = []
        result = transport.request("ping", {}, timeout=3.0, on_start=seen.append)
        self.assertEqual(seen, [1])
        self.assertEqual(result, {"id": 1})

    def test_cancel_wakes_waiter_and_sends_notification(self):
        handle = tempfile.NamedTemporaryFile(prefix="bb-cancel-", suffix=".json", delete=False)
        path = handle.name
        handle.close()
        code = (
            "import json, sys\n"
            "req = json.loads(sys.stdin.buffer.readline().decode('utf-8'))\n"
            "cancel = json.loads(sys.stdin.buffer.readline().decode('utf-8'))\n"
            "open(%r, 'w', encoding='utf-8').write(json.dumps(cancel, ensure_ascii=False))\n"
            "import time\n"
            "time.sleep(0.1)\n" % path
        )
        transport = self._spawn(code)
        errors = []

        def worker():
            try:
                transport.request("tools/call", {}, timeout=5.0)
            except BridgeError as error:
                errors.append(error)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.assertTrue(self._wait_until(lambda: transport._seq >= 1))
        time.sleep(0.05)
        self.assertTrue(transport.cancel(1, "用户取消"))
        thread.join(timeout=5.0)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].code, "E_CANCELLED")
        self.assertEqual(errors[0].data["requestId"], 1)
        self.assertEqual(errors[0].data["reason"], "用户取消")
        self.assertTrue(self._wait_until(lambda: os.path.exists(path) and os.path.getsize(path) > 0))
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        self.assertEqual(payload["method"], "notifications/cancelled")
        self.assertEqual(payload["params"]["requestId"], 1)
        self.assertEqual(payload["params"]["reason"], "用户取消")
        os.unlink(path)

    @staticmethod
    def _wait_until(predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False


if __name__ == "__main__":
    unittest.main()
