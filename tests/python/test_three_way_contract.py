"""tests/python/test_three_way_contract.py —— Python ↔ Node ↔ MCP 三方契约测试。

同一份工具契约被三方消费：Python SDK 内嵌目录、Node SDK 目录、MCP server 的
tools/list。这里同时拉起 node（导出 SDK 目录/错误码）与真实 MCP server，逐项对账：

  - 92 工具名称与顺序（Python 生成目录 / Node listToolSpecs / MCP tools/list）；
  - 分档 tier、审批、超时、openWorld/idempotent（Python / Node / MCP _meta policy）；
  - 入参 required/properties 类型/枚举/additionalProperties（Python / Node / MCP inputSchema）；
  - 分页标记与 cursor 参数（Python / Node / MCP schema）；
  - 错误码集合与恢复建议（Python / Node lib/error-codes.mjs）；
  - featureGates / minProtocol（Node / MCP _meta policy）。

没有 node 时整体 skip（不伪装通过）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    ERROR_CODES,
    McpToolClient,
    RECOVERY_HINTS,
    TOOL_CATALOG,
    TOOL_CATALOG_META,
    list_tools,
    pagination_markers,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("BB_NODE") or shutil.which("node")

NODE_DUMP_SCRIPT = """
import { listToolSpecs } from './sdk/tool-catalog.mjs';
import { ERROR_CODE_LIST, ERROR_RECOVERY } from './lib/error-codes.mjs';
process.stdout.write(JSON.stringify({
  tools: listToolSpecs(),
  errorCodes: ERROR_CODE_LIST,
  recovery: ERROR_RECOVERY,
}));
"""


def normalize_type(value):
    if isinstance(value, (list, tuple)):
        return tuple(value)
    return value


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class ThreeWayContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", NODE_DUMP_SCRIPT],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        if completed.returncode != 0:
            raise RuntimeError("node SDK 目录导出失败：" + str(completed.stderr)[:500])
        cls.node = json.loads(completed.stdout)
        cls.node_tools = {tool["name"]: tool for tool in cls.node["tools"]}
        cls.home = tempfile.mkdtemp(prefix="bb-py-3way-")
        cls.client = McpToolClient(home=cls.home, node=NODE).connect()
        cls.mcp_list = cls.client.list_mcp_tools()
        cls.mcp_tools = {tool["name"]: tool for tool in cls.mcp_list}

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_01_tool_names_and_order_three_way(self):
        python_names = list(TOOL_CATALOG_META["order"])
        node_names = [tool["name"] for tool in self.node["tools"]]
        mcp_names = [tool["name"] for tool in self.mcp_list]
        self.assertEqual(len(python_names), 92)
        self.assertEqual(python_names, node_names)
        self.assertEqual(python_names, mcp_names)
        self.assertEqual(sorted(python_names), sorted(self.node_tools))
        self.assertEqual(sorted(python_names), sorted(self.mcp_tools))

    def test_02_tier_approval_timeout_three_way(self):
        for name in TOOL_CATALOG_META["order"]:
            python = TOOL_CATALOG[name]
            node = self.node_tools[name]
            policy = self.mcp_tools[name]["_meta"]["browser-bridge/policy"]
            self.assertEqual(python["tier"], node["tier"], name + '.tier')
            self.assertEqual(python["tier"], policy["tier"], name + '.tier(mcp)')
            self.assertEqual(python["timeout_ms"], node["timeoutMs"], name + '.timeoutMs')
            self.assertEqual(python["timeout_ms"], policy["timeoutMs"], name + '.timeoutMs(mcp)')
            self.assertEqual(python["approval_required"], node["approvalRequired"], name + '.approval')
            self.assertEqual(python["approval_required"], policy["approval"], name + '.approval(mcp)')
            self.assertEqual(python["open_world"], node["openWorld"], name + '.openWorld')
            self.assertEqual(python["open_world"], policy["openWorld"], name + '.openWorld(mcp)')
            self.assertEqual(python["idempotent"], node["idempotent"], name + '.idempotent')
            self.assertEqual(python["idempotent"], policy["idempotent"], name + '.idempotent(mcp)')

    def test_03_required_and_properties_three_way(self):
        for name in TOOL_CATALOG_META["order"]:
            python = TOOL_CATALOG[name]
            node = self.node_tools[name]
            schema = self.mcp_tools[name]["inputSchema"]
            python_props = dict(python["props"])
            self.assertEqual(list(python["required"]), list(schema.get("required") or []), name + '.required(mcp)')
            self.assertEqual(list(python["required"]), list(node["required"]), name + '.required(node)')
            self.assertEqual(list(python_props), list((schema.get("properties") or {}).keys()), name + '.props(mcp)')
            self.assertEqual(list(python_props), list(node["properties"].keys()), name + '.props(node)')
            expected_additional = schema.get("additionalProperties") is not False
            self.assertEqual(python["additional_properties"], expected_additional, name + '.additionalProperties')
            for prop_name, definition in python_props.items():
                mcp_def = (schema.get("properties") or {})[prop_name]
                node_def = node["properties"][prop_name]
                self.assertEqual(normalize_type(definition.get("type")), normalize_type(mcp_def.get("type")), name + '.' + prop_name + '.type(mcp)')
                self.assertEqual(normalize_type(definition.get("type")), normalize_type(node_def.get("type")), name + '.' + prop_name + '.type(node)')
                self.assertEqual(tuple(definition.get("enum") or ()), tuple(mcp_def.get("enum") or ()), name + '.' + prop_name + '.enum(mcp)')
                self.assertEqual(tuple(definition.get("enum") or ()), tuple(node_def.get("enum") or ()), name + '.' + prop_name + '.enum(node)')
                for constraint in ("minimum", "maximum", "minItems", "maxItems"):
                    self.assertEqual(definition.get(constraint), node_def.get(constraint), name + '.' + prop_name + '.' + constraint)
                if "items" in mcp_def:
                    self.assertEqual(definition.get("items_type"), mcp_def["items"].get("type"), name + '.' + prop_name + '.items_type')

    def test_04_pagination_three_way(self):
        python_paginated = [name for name in TOOL_CATALOG_META["order"] if TOOL_CATALOG[name]["pagination"]]
        node_paginated = [tool["name"] for tool in self.node["tools"] if tool["pagination"]["partial"]]
        self.assertEqual(python_paginated, node_paginated)
        self.assertEqual(len(python_paginated), 8)
        for name in TOOL_CATALOG_META["order"]:
            python = TOOL_CATALOG[name]["pagination"]
            node = self.node_tools[name]["pagination"]
            markers = pagination_markers(name)
            self.assertEqual(bool(python), node["partial"], name + '.partial')
            self.assertEqual(markers["partial"], node["partial"], name + '.partial(marker)')
            if python:
                self.assertEqual(list(python["methods"]), list(node["methods"]), name + '.methods')
                self.assertEqual(list(python["result_fields"]), list(node["resultFields"]), name + '.resultFields')
                self.assertEqual(python["cursor_param"], node["cursorParam"], name + '.cursorParam')
                schema_props = self.mcp_tools[name]["inputSchema"].get("properties") or {}
                if node["cursorParam"]:
                    self.assertIn(node["cursorParam"], schema_props, name + ' 分页工具 schema 应有 cursor 参数')
                else:
                    self.assertIsNone(python["cursor_param"], name + '.cursorParam')

    def test_05_feature_gates_and_min_protocol_three_way(self):
        for name in TOOL_CATALOG_META["order"]:
            node = self.node_tools[name]
            policy = self.mcp_tools[name]["_meta"]["browser-bridge/policy"]
            self.assertEqual(list(node["featureGates"]), list(policy["featureGates"]), name + '.featureGates')
            self.assertEqual(node["minProtocol"], policy["minProtocol"], name + '.minProtocol')
        self.assertEqual(TOOL_CATALOG_META["protocol"], "1.9")

    def test_06_error_codes_and_recovery_three_way(self):
        node_codes = set(self.node["errorCodes"])
        self.assertEqual(set(ERROR_CODES), node_codes)
        self.assertGreaterEqual(len(node_codes), 150)
        # Python 只内嵌高频恢复建议，但每一条都必须与 Node 的 ERROR_RECOVERY 完全一致。
        for code, advice in RECOVERY_HINTS.items():
            self.assertIn(code, node_codes, '未登记错误码：' + code)
            expected = self.node["recovery"].get(code) or {"retry": "no", "hint": ""}
            self.assertEqual(advice, (expected["retry"], expected["hint"]), code)
        self.assertGreaterEqual(len(RECOVERY_HINTS), 10)

    def test_07_tier_summary_three_way(self):
        python_rows = list_tools()
        python_by_tier = {
            "read": len([row for row in python_rows if row["tier"] == "read"]),
            "mutate": len([row for row in python_rows if row["tier"] == "mutate"]),
            "destructive": len([row for row in python_rows if row["tier"] == "destructive"]),
        }
        node_by_tier = {"read": 0, "mutate": 0, "destructive": 0}
        for tool in self.node["tools"]:
            node_by_tier[tool["tier"]] += 1
        mcp_by_tier = self.mcp_list[0]["_meta"]["browser-bridge/policy"]  # 每工具 policy 存在即可
        self.assertIsInstance(mcp_by_tier, dict)
        self.assertEqual(python_by_tier, node_by_tier)
        self.assertEqual(python_by_tier, TOOL_CATALOG_META["tiers"])
        self.assertEqual(sum(python_by_tier.values()), 92)
        self.assertEqual(python_by_tier["read"], 36)
        self.assertEqual(python_by_tier["mutate"], 49)
        self.assertEqual(python_by_tier["destructive"], 7)


if __name__ == "__main__":
    unittest.main()
