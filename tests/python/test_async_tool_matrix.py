"""tests/python/test_async_tool_matrix.py —— Python 异步客户端「全 92 工具矩阵」深度测试。

覆盖：
  - audit_async_matrix() 硬审计（92 工具、tier 分布、审批/分页标记、客户端方法齐全）；
  - tool_matrix_rows()/async_tool_matrix_snapshot() 矩阵元数据；
  - AsyncToolMatrix 的属性式访问（每个工具一个 async 方法）、未知工具抛 AttributeError；
  - 92 个工具全部经矩阵路由到 tools/call（validate=False + approval=True 绕过本地闸门）；
  - matrix.call/detailed/paged/with_retry 的转发、coverage()/matrix() 元数据；
  - 每个工具的工具级默认超时与分页标记（与 catalog 单一来源对账）；
  - 审批闸门对矩阵调用同样生效（approval_required 工具不传 approval 即 E_HUMAN_GATE）。
"""

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

import browser_bridge_async as asyncmod  # noqa: E402
from browser_bridge import TOOL_APPROVAL_ALWAYS, TOOL_CATALOG, TOOL_CATALOG_META, ToolCallError, pagination_markers  # noqa: E402
from browser_bridge_async import (  # noqa: E402
    AsyncMcpToolClient,
    AsyncToolMatrix,
    async_tool_matrix_snapshot,
    audit_async_matrix,
    tool_matrix_rows,
)


class MatrixFakeTransport:
    """只记录 tools/call 的 fake 传输（矩阵路由测试用）。"""

    def __init__(self):
        self.calls = []
        self.requests = []
        self.listeners = []
        self.closed = False
        self.seq = 0

    async def start(self):
        return self

    async def request(self, method, params=None, timeout=None, on_start=None):
        if self.closed:
            raise RuntimeError("closed")
        self.seq += 1
        params = params or {}
        self.requests.append({"method": method, "params": params, "timeout": timeout})
        if on_start is not None:
            result = on_start(self.seq)
            if asyncio.iscoroutine(result):
                await result
        if method == "initialize":
            return {
                "protocolVersion": "2024-11-05",
                "capabilities": {"resources": {"subscribe": True}},
                "serverInfo": {"name": "matrix-fake", "version": "0.0.1"},
            }
        if method == "tools/call":
            name = params.get("name")
            self.calls.append({"name": name, "args": params.get("arguments") or {}, "meta": params.get("_meta") or {}})
            return {
                "content": [{"type": "text", "text": json.dumps({"ok": True, "tool": name})}],
                "isError": False,
                "_meta": {"browser-bridge/tier": TOOL_CATALOG[name]["tier"]},
            }
        return {}

    async def notify(self, method, params=None):
        return None

    def add_notification_handler(self, handler):
        self.listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler):
        return False

    def cancel(self, request_id, reason=""):
        return False

    async def close(self):
        self.closed = True


def run(coro):
    return asyncio.run(coro)


class MatrixAuditTest(unittest.TestCase):
    def test_audit_async_matrix_ok(self):
        report = audit_async_matrix()
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["total"], 92)
        self.assertEqual(report["by_tier"], {"read": 36, "mutate": 49, "destructive": 7})
        self.assertEqual(report["approval_required"], 7)
        self.assertEqual(report["paginated"], 8)
        self.assertEqual(report["version"], asyncmod.ASYNC_SDK_VERSION)

    def test_tool_matrix_rows_match_catalog(self):
        rows = tool_matrix_rows()
        self.assertEqual(len(rows), 92)
        self.assertEqual(tuple(row["name"] for row in rows), tuple(TOOL_CATALOG_META["order"]))
        by_name = {row["name"]: row for row in rows}
        self.assertEqual(by_name["browser_status"]["tier"], "read")
        self.assertEqual(by_name["browser_evaluate"]["tier"], "destructive")
        self.assertTrue(by_name["browser_evaluate"]["approval_required"])
        self.assertTrue(by_name["browser_update"]["approval_always"])
        self.assertTrue(by_name["browser_observe"]["partial"])
        self.assertIsNone(by_name["browser_status"]["pagination"])
        for row in rows:
            self.assertGreaterEqual(row["timeout_ms"], 1_000)
            self.assertLessEqual(row["timeout_ms"], 900_000)
            self.assertIsInstance(row["methods"], list)

    def test_snapshot(self):
        snapshot = async_tool_matrix_snapshot()
        self.assertTrue(snapshot["supported"])
        self.assertEqual(snapshot["total"], 92)
        self.assertEqual(snapshot["by_tier"]["destructive"], 7)
        self.assertEqual(snapshot["approval_always"], list(TOOL_APPROVAL_ALWAYS))
        self.assertEqual(sorted(snapshot["paginated"]), sorted(
            name for name, spec in TOOL_CATALOG.items() if spec["pagination"] and spec["pagination"].get("partial")
        ))
        self.assertIn("call_tool_with_retry", snapshot["client_methods"])
        self.assertIn("sync_resource_subscriptions", snapshot["client_methods"])
        self.assertEqual(snapshot["timeout_range_ms"][0] < snapshot["timeout_range_ms"][1], True)


class MatrixAccessTest(unittest.TestCase):
    def setUp(self):
        self.transport = MatrixFakeTransport()
        self.client = AsyncMcpToolClient(transport=self.transport)
        run(self.client.connect())
        self.matrix = self.client.tools

    def tearDown(self):
        run(self.client.close())

    def test_matrix_identity_and_container_protocol(self):
        self.assertIsInstance(self.matrix, AsyncToolMatrix)
        self.assertEqual(len(self.matrix), 92)
        self.assertEqual(len(tuple(self.matrix)), 92)
        self.assertIn("browser_status", self.matrix)
        self.assertNotIn("browser_nope", self.matrix)
        self.assertEqual(len(self.matrix.names()), 92)
        self.assertEqual(self.matrix.names(), tuple(TOOL_CATALOG_META["order"]))
        self.assertEqual(self.matrix.spec("browser_status")["tier"], "read")
        with self.assertRaises(Exception):
            self.matrix.spec("browser_nope")

    def test_unknown_tool_attribute_raises(self):
        with self.assertRaises(AttributeError):
            _ = self.matrix.browser_nope
        # 内部/下划线属性不应被当成工具。
        with self.assertRaises(AttributeError):
            _ = self.matrix.__nope__

    def test_each_tool_has_async_callable(self):
        for name in self.matrix.names():
            method = getattr(self.matrix, name)
            self.assertTrue(callable(method), name)
            self.assertEqual(method.__name__, name)
            self.assertTrue(asyncio.iscoroutinefunction(method), name)

    def test_all_67_tools_route_through_matrix(self):
        async def main():
            for name in self.matrix.names():
                # validate=False + approval=True：矩阵路由验证，不触发本地参数/审批闸门。
                result = await getattr(self.matrix, name)({}, validate=False, approval=True)
                self.assertEqual(result["tool"], name)
            self.assertEqual(len(self.transport.calls), 92)
            self.assertEqual([call["name"] for call in self.transport.calls], list(self.matrix.names()))
            # destructive 工具的调用带 approval token。
            evaluate = next(call for call in self.transport.calls if call["name"] == "browser_evaluate")
            self.assertEqual(evaluate["meta"]["browser-bridge/approval"], "confirmed")

        run(main())

    def test_missing_args_rejected_by_default_for_required_tools(self):
        # browser_evaluate 必填 expression；不传时矩阵同样走本地校验。
        with self.assertRaises(ToolCallError) as ctx:
            run(self.matrix.browser_evaluate({}))
        self.assertEqual(ctx.exception.code, "E_ARG_MISSING")

    def test_approval_gate_applies_to_matrix(self):
        with self.assertRaises(ToolCallError) as ctx:
            run(self.matrix.browser_evaluate({"expression": "1+1"}))
        self.assertEqual(ctx.exception.code, "E_HUMAN_GATE")
        result = run(self.matrix.browser_evaluate({"expression": "1+1"}, approval=True))
        self.assertEqual(result["tool"], "browser_evaluate")

    def test_call_detailed_paged_with_retry_forwarding(self):
        async def main():
            direct = await self.matrix.call("browser_status", {})
            self.assertEqual(direct["tool"], "browser_status")
            detailed = await self.matrix.detailed("browser_status", {})
            self.assertIn("progress_summary", detailed)
            self.assertIn("payload", detailed)
            paged = await self.matrix.paged("browser_observe", {}, max_pages=2)
            self.assertEqual(len(paged), 1, "非分页 fake 只返回一页")
            retried = await self.matrix.with_retry("browser_status", {}, max_attempts=2)
            self.assertEqual(retried["tool"], "browser_status")
            self.assertEqual(len(self.transport.calls), 4)

        run(main())

    def test_coverage_and_matrix_metadata(self):
        coverage = self.matrix.coverage()
        self.assertEqual(coverage["total"], 92)
        self.assertEqual(coverage["by_tier"], {"read": 36, "mutate": 49, "destructive": 7})
        self.assertEqual(coverage["missing"], [])
        self.assertEqual(len(coverage["approval_required"]), 7)
        self.assertEqual(len(coverage["paginated"]), 8)
        matrix = self.matrix.matrix()
        self.assertEqual(len(matrix), 92)
        self.assertEqual(matrix["browser_observe"]["partial"], True)
        self.assertEqual(list(matrix["browser_observe"]["pagination"]["methods"]), ["observe"])
        self.assertEqual(matrix["browser_status"]["partial"], False)
        # 客户端级覆盖审计 = 同步模块同一份实现 + 异步字段。
        client_coverage = self.client.tool_coverage()
        self.assertEqual(client_coverage["async_total"], 92)
        self.assertEqual(client_coverage["async_missing"], [])
        self.assertEqual(self.client.matrix_coverage()["total"], 92)

    def test_pagination_markers_consistent_per_tool(self):
        for name, spec in TOOL_CATALOG.items():
            markers = pagination_markers(name)
            if spec["pagination"] and spec["pagination"].get("partial"):
                self.assertTrue(markers["partial"], name)
                self.assertIn('cursorParam', markers)
                self.assertTrue(markers['resultFields'])
            else:
                self.assertFalse(markers["partial"], name)


class MatrixTimeoutTest(unittest.TestCase):
    def test_tool_timeouts_come_from_catalog(self):
        transport = MatrixFakeTransport()
        client = AsyncMcpToolClient(transport=transport, timeout=99.0)

        async def main():
            await client.connect()
            await client.call_tool("browser_status", {}, validate=False)
            call = next(row for row in transport.requests if row["method"] == "tools/call")
            # call_tool 不传 timeout 时按工具策略 timeout_ms 换算成秒。
            expected = TOOL_CATALOG["browser_status"]["timeout_ms"] / 1000.0
            self.assertEqual(call["timeout"], expected)
            # 显式 timeout 覆盖工具默认值。
            await client.call_tool("browser_status", {}, validate=False, timeout=1.5)
            call = [row for row in transport.requests if row["method"] == "tools/call"][-1]
            self.assertEqual(call["timeout"], 1.5)
            await client.close()

        run(main())


if __name__ == "__main__":
    unittest.main()
