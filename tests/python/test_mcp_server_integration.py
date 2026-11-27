"""tests/python/test_mcp_server_integration.py —— Python SDK 与真实 MCP server 的集成测试。

真正拉起 `node mcp/server.mjs`（stdio JSON-RPC），验证：
  - initialize 能力声明（resources.subscribe=true / 分页参数）；
  - 92 工具目录与 Python 生成目录一致；
  - tools/call 错误路径（无 daemon → E_DAEMON）与结构化错误码；
  - resources 读取/分页续读可还原完整内容；
  - prompts 列表/渲染/枚举校验；
  - resources/subscribe 成功、非法 URI 返回 -32602、unsubscribe 幂等；
  - close 后调用返回 E_DISCONNECTED。

没有 node 时整体 skip（不伪装通过）：测试环境需要 node 在 PATH 或设置 BB_NODE。
"""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    BridgeError,
    McpToolClient,
    TOOL_CATALOG_META,
    ToolCallError,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("BB_NODE") or shutil.which("node")
PAGED_MARKER = re.compile(r"\n\n…\[paged\][\s\S]*$")


def strip_paged_marker(text):
    return PAGED_MARKER.sub("", text)


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class McpServerIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp(prefix="bb-py-mcp-it-")
        cls.client = McpToolClient(home=cls.home, node=NODE).connect()

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_01_initialize_capabilities(self):
        self.assertEqual(self.client.server_info.get("name"), "browser-bridge")
        resources = self.client.capabilities.get("resources") or {}
        self.assertEqual(resources.get("subscribe"), True)
        self.assertEqual(resources.get("subscription", {}).get("notification"), "notifications/resources/updated")
        self.assertEqual(resources.get("subscription", {}).get("uriScoped"), True)
        self.assertEqual(resources.get("pagination", {}).get("cursorParam"), "cursor")
        self.assertEqual(resources.get("pagination", {}).get("maxLimit"), 65536)
        self.assertIsInstance(self.client.capabilities.get("tools"), dict)
        self.assertIsInstance(self.client.capabilities.get("prompts"), dict)

    def test_02_tools_list_matches_python_catalog(self):
        tools = self.client.list_mcp_tools()
        self.assertEqual(len(tools), 92)
        names = [tool["name"] for tool in tools]
        self.assertEqual(names, list(TOOL_CATALOG_META["order"]))
        for tool in tools:
            self.assertIn("inputSchema", tool)
            self.assertEqual(tool["inputSchema"]["type"], "object")

    def test_03_resources_list_prompts_list(self):
        resources = self.client.list_resources()
        uris = [resource["uri"] for resource in resources]
        self.assertIn("bridge://skill/SKILL.md", uris)
        self.assertIn("bridge://protocol/summary", uris)
        self.assertIn("bridge://observation/latest", uris)
        self.assertIn("bridge://debug/journal/latest", uris)
        prompts = self.client.list_prompts()
        names = [prompt["name"] for prompt in prompts]
        self.assertGreaterEqual(len(prompts), 9)
        for name in ("har_analysis", "network_diagnosis", "longshot_recovery", "video_verify"):
            self.assertIn(name, names)

    def test_04_skill_and_protocol_resources(self):
        skill = self.client.read_resource("bridge://skill/SKILL.md")
        text = skill["contents"][0]["text"]
        self.assertGreater(len(text), 500)
        reference = self.client.read_resource("bridge://skill/references/environment.md")
        self.assertIn("环境", reference["contents"][0]["text"])
        summary = self.client.read_resource("bridge://protocol/summary")
        payload = json.loads(summary["contents"][0]["text"])
        self.assertEqual(payload["protocol"]["current"], "1.9")
        self.assertGreaterEqual(payload["methods"]["total"], 160)
        self.assertGreaterEqual(len(payload["features"]), 9)
        self.assertIn("observe", payload["partialMethods"])

    def test_05_resource_paging_chain_reassembles(self):
        full = self.client.read_resource("bridge://protocol/summary")["contents"][0]["text"]
        chunks = []
        uri = "bridge://protocol/summary?limit=500"
        pages = 0
        while uri and pages < 100:
            result = self.client.read_resource(uri)
            meta = result["_meta"]["browser-bridge/resource"]
            self.assertEqual(meta["paged"], True)
            self.assertLessEqual(meta["returnedChars"], 500)
            chunks.append(strip_paged_marker(result["contents"][0]["text"]))
            uri = meta["nextUri"]
            pages += 1
        self.assertGreater(pages, 1)
        self.assertEqual("".join(chunks), full)
        self.assertGreaterEqual(json.loads(full)["methods"]["total"], 160)

    def test_06_prompts_render_and_validation(self):
        rendered = self.client.get_prompt("har_analysis", {"source": "latest", "focus": "errors"})
        text = rendered["messages"][0]["content"]["text"]
        self.assertIn("browser_network_waterfall", text)
        self.assertIn("errors", text)
        self.assertEqual(rendered["_meta"]["browser-bridge/prompt"]["name"], "har_analysis")
        longshot = self.client.get_prompt("longshot_recovery", {"failure": "gap"})
        self.assertIn("manifest", longshot["messages"][0]["content"]["text"])
        with self.assertRaises(BridgeError) as caught:
            self.client.get_prompt("longshot_recovery", {"failure": "not-a-failure"})
        self.assertEqual(caught.exception.code, "E_RPC")
        self.assertEqual(caught.exception.data["code"], -32602)
        with self.assertRaises(BridgeError) as missing:
            self.client.get_prompt("har_analysis", {})
        self.assertEqual(missing.exception.data["code"], -32602)
        self.assertIn("source", missing.exception.data["message"])

    def test_07_tool_error_path_without_daemon(self):
        with self.assertRaises(ToolCallError) as caught:
            self.client.call_tool("browser_status", {})
        error = caught.exception
        self.assertEqual(error.code, "E_DAEMON")
        self.assertEqual(error.tool, "browser_status")
        self.assertIn("daemon", error.message)
        payload = error.to_dict()
        self.assertEqual(payload["tool"], "browser_status")

    def test_08_resources_subscribe_and_unsubscribe(self):
        # W7-C 能力升级：subscribe=true，订阅返回 _meta 报告；URI 级精确匹配。
        self.assertTrue(self.client.supports_resource_subscriptions())
        report = self.client.subscribe_resource("bridge://observation/latest")
        self.assertEqual(report.get("uri"), "bridge://observation/latest")
        self.assertEqual(report.get("added"), True)
        self.assertEqual(report.get("active"), 1)
        self.assertEqual(report.get("notification"), "notifications/resources/updated")
        self.assertEqual(self.client.resource_subscriptions(), ["bridge://observation/latest"])
        # 重复订阅幂等
        again = self.client.subscribe_resource("bridge://observation/latest")
        self.assertEqual(again.get("added"), False)
        # 会话级 URI 也可以订阅（稍后才会写入的快照）
        sample = self.client.subscribe_resource("bridge://observation/sample-session")
        self.assertEqual(sample.get("added"), True)
        self.assertEqual(sample.get("active"), 2)
        removed = self.client.unsubscribe_resource("bridge://observation/sample-session")
        self.assertEqual(removed.get("found"), True)
        self.assertEqual(self.client.resource_subscriptions(), ["bridge://observation/latest"])
        # 未订阅过也按规范返回成功（found=false 而不是错误）
        missing = self.client.unsubscribe_resource("bridge://debug/journal/latest")
        self.assertEqual(missing.get("found"), False)
        self.client.unsubscribe_resource("bridge://observation/latest")
        self.assertEqual(self.client.resource_subscriptions(), [])

    def test_08b_resources_subscribe_bad_uri_rejected(self):
        with self.assertRaises(BridgeError) as caught:
            self.client.subscribe_resource("bridge://nope")
        self.assertEqual(caught.exception.code, "E_RPC")
        self.assertEqual(caught.exception.data["code"], -32002)
        with self.assertRaises(BridgeError) as bad:
            self.client.transport.request("resources/subscribe", {"uri": "bridge://protocol/summary?limit=0"}, timeout=5)
        self.assertEqual(bad.exception.data["code"], -32602)
        with self.assertRaises(BridgeError) as missing:
            self.client.transport.request("resources/subscribe", {}, timeout=5)
        self.assertEqual(missing.exception.data["code"], -32602)

    def test_09_unknown_resource_and_bad_query_codes(self):
        with self.assertRaises(BridgeError) as missing:
            self.client.read_resource("bridge://debug/journal/latest")
        self.assertEqual(missing.exception.data["code"], -32002)
        with self.assertRaises(BridgeError) as bad:
            self.client.read_resource("bridge://protocol/summary?limit=0")
        self.assertEqual(bad.exception.data["code"], -32602)


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class McpClientLifecycleIntegrationTest(unittest.TestCase):
    def test_close_then_call_disconnected(self):
        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-mcp-life-"), node=NODE).connect()
        self.assertTrue(client.connected)
        client.close()
        self.assertFalse(client.connected)
        with self.assertRaises(BridgeError) as caught:
            client.call_tool("browser_status", {})
        self.assertEqual(caught.exception.code, "E_DISCONNECTED")
        client.close()  # 幂等

    def test_missing_node_reported(self):
        client = McpToolClient(home=tempfile.mkdtemp(prefix="bb-py-mcp-nonode-"), node=None, transport=None)
        client.node = None
        with self.assertRaises(BridgeError) as caught:
            client.connect()
        self.assertEqual(caught.exception.code, "E_ENV")


if __name__ == "__main__":
    unittest.main()
