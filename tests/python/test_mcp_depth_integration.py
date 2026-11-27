"""tests/python/test_mcp_depth_integration.py —— Python SDK 与真实 MCP server 的深度面集成测试。

真正拉起 `node mcp/server.mjs`（stdio JSON-RPC），验证 W6/W7 新增能力在协议上的可见性：
  - initialize.experimental：progress / cancellation / snapshots / resource-subscriptions 扩展能力声明；
  - tools/list 每个工具带进度档位，screenshot→stream、observe→observe；
  - 无 daemon 时带 progress=True 调用仍按协议返回结构化错误，本地进度回调收尾正确；
  - resources/list 报告快照持久化状态（enabled/dir）与订阅上限，subscribe 为 true；
  - resources/subscribe/unsubscribe 在真实 server 上可用（URI 级、幂等）；
  - 真实 transport 上 cancel 未知请求返回 False（不抛错）。

没有 node 时整体 skip（不伪装通过）。
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    McpToolClient,
    ToolCallError,
)

NODE = os.environ.get("BB_NODE") or shutil.which("node")


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class McpDepthIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp(prefix="bb-py-mcp-depth-")
        cls.client = McpToolClient(home=cls.home, node=NODE).connect()

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_01_initialize_declares_depth_capabilities(self):
        experimental = self.client.capabilities.get("experimental") or {}
        progress = experimental.get("browser-bridge/progress") or {}
        self.assertEqual(progress.get("supported"), True)
        self.assertEqual(progress.get("notification"), "notifications/progress")
        self.assertEqual(progress.get("tokenMeta"), "_meta.progressToken")
        self.assertIn("stream", progress.get("classes") or [])
        self.assertGreaterEqual(progress.get("maxNotifications") or 0, 1)

        cancellation = experimental.get("browser-bridge/cancellation") or {}
        self.assertEqual(cancellation.get("supported"), True)
        self.assertEqual(cancellation.get("notification"), "notifications/cancelled")
        self.assertEqual(cancellation.get("response"), "suppressed")
        self.assertEqual(cancellation.get("remoteDaemonCancel"), True)
        self.assertEqual(cancellation.get("remoteMethods"), ["inflight.list", "command.cancel"])

        snapshots = experimental.get("browser-bridge/snapshots") or {}
        self.assertEqual(snapshots.get("persisted"), True)
        self.assertIn("mcp-snapshots", str(snapshots.get("dir")))
        self.assertGreaterEqual(snapshots.get("ttlMs") or 0, 1)
        self.assertGreaterEqual(snapshots.get("maxTotalBytes") or 0, 1)
        self.assertGreaterEqual(snapshots.get("maxEntryBytes") or 0, 1)

        subscriptions = experimental.get("browser-bridge/resource-subscriptions") or {}
        self.assertEqual(subscriptions.get("supported"), True)
        self.assertEqual(subscriptions.get("notification"), "notifications/resources/updated")
        self.assertEqual(subscriptions.get("uriScoped"), True)
        self.assertEqual(subscriptions.get("cleanupOnDisconnect"), True)
        self.assertGreaterEqual(subscriptions.get("maxSubscriptions") or 0, 1)
        self.assertIn("resources/subscribe", subscriptions.get("methods") or [])

    def test_02_resources_capability_and_subscriptions(self):
        resources = self.client.capabilities.get("resources") or {}
        self.assertEqual(resources.get("subscribe"), True)
        listed = self.client.list_resources()
        self.assertGreaterEqual(len(listed), 5)
        # resources/list 的 _meta 在 read_resource 里不可见，直接用 transport 取一次完整结果。
        result = self.client.transport.request("resources/list", {}, timeout=10)
        meta = result["_meta"]["browser-bridge/resources"]
        self.assertEqual(meta["subscribe"], True)
        self.assertEqual(meta["subscription"]["notification"], "notifications/resources/updated")
        self.assertEqual(meta["subscription"]["active"], self._subscribed_before_list())
        self.assertGreaterEqual(meta["subscription"]["maxSubscriptions"], 1)
        self.assertEqual(meta["persistence"]["enabled"], True)
        self.assertIn("mcp-snapshots", str(meta["persistence"]["dir"]))
        self.assertGreaterEqual(meta["persistence"].get("files", 0), 0)
        self.assertIn("restored", meta)
        self.assertIn("updates", meta)

    def _subscribed_before_list(self):
        # 本类测试可能已订阅过；只要求计数与实际订阅集合一致（不依赖执行顺序硬编码）。
        return len(self.client.resource_subscriptions())

    def test_03_tools_list_exposes_progress_classes(self):
        tools = self.client.list_mcp_tools()
        self.assertEqual(len(tools), 92)
        rows = {tool["name"]: tool for tool in tools}
        self.assertEqual(rows["browser_screenshot"]["_meta"]["browser-bridge/progress"]["class"], "stream")
        self.assertEqual(rows["browser_observe"]["_meta"]["browser-bridge/progress"]["class"], "observe")
        self.assertEqual(rows["browser_status"]["_meta"]["browser-bridge/progress"]["class"], "fast")
        for tool in tools:
            progress = tool["_meta"]["browser-bridge/progress"]
            self.assertIn(progress["class"], ("stream", "observe", "interactive", "fast"))
            self.assertGreaterEqual(progress["intervalMs"], 1)
            self.assertGreaterEqual(progress["maxNotifications"], 1)

    def test_04_progress_call_without_daemon_reports_error(self):
        events = []
        with self.assertRaises(ToolCallError) as caught:
            self.client.call_tool("browser_status", {}, progress=True, on_progress=events.append)
        self.assertEqual(caught.exception.code, "E_DAEMON")
        phases = [event["phase"] for event in events]
        self.assertEqual(phases[0], "start")
        self.assertEqual(phases[-1], "error")
        self.assertGreaterEqual(len(phases), 2)

    def test_04b_resource_subscription_lifecycle(self):
        self.assertTrue(self.client.supports_resource_subscriptions())
        report = self.client.subscribe_resource("bridge://debug/journal/latest")
        self.assertEqual(report.get("added"), True)
        self.assertIn("bridge://debug/journal/latest", self.client.resource_subscriptions())
        seen = []
        handler = self.client.add_resource_updated_handler(seen.append)
        self.assertTrue(callable(handler))
        self.assertTrue(self.client.remove_resource_updated_handler(handler))
        self.assertFalse(self.client.remove_resource_updated_handler(handler))
        # 传输不支持通知回调时明确报错（而不是静默丢失回调）。
        with self.assertRaises(Exception) as caught:
            self.client.add_resource_updated_handler(None)
        self.assertEqual(getattr(caught.exception, "code", None), "E_ARG_TYPE")
        removed = self.client.unsubscribe_resource("bridge://debug/journal/latest")
        self.assertEqual(removed.get("found"), True)
        self.assertEqual(self.client.resource_subscriptions(), [])

    def test_05_cancel_unknown_request_is_false(self):        # 真实 transport：没有在途请求时取消按规范尽力而为，返回 False 且不抛异常。
        self.assertFalse(self.client.cancel_request(987654, "不存在"))
        # 取消后连接仍可用（走一次正常的错误路径调用）。
        with self.assertRaises(ToolCallError):
            self.client.call_tool("browser_status", {})

    def test_06_tools_call_meta_contains_progress_block(self):
        # 无 daemon 的错误结果也应带 browser-bridge/progress 元数据（诊断“是否发过通知”）。
        result = self.client.transport.request(
            "tools/call",
            {"name": "browser_status", "arguments": {}, "_meta": {"progressToken": "depth-meta"}},
            timeout=10,
        )
        self.assertEqual(result["isError"], True)
        progress_meta = result["_meta"]["browser-bridge/progress"]
        self.assertEqual(progress_meta["enabled"], True)
        self.assertEqual(progress_meta["class"], "fast")
        self.assertEqual(progress_meta["finalPhase"], "error")
        self.assertGreaterEqual(progress_meta["emitted"], 2)
        self.assertEqual(result["_meta"]["browser-bridge/errorCode"], "E_DAEMON")


if __name__ == "__main__":
    unittest.main()
