"""tests/python/test_mcp_protocol_deep.py —— MCP 协议深度的三方契约 + 真实 server 集成测试。

两部分：

A. 三方对账（Python SDK ↔ Node mcp/*.mjs ↔ 真实 MCP server）：
   - 错误码分类（category/retry/terminal/json_rpc_code）与重试计划/退避延迟逐值一致；
   - 游标编码格式跨语言一致（Python 造出的 bb1.resources.<base36> 能被 Node 解码）；
   - prompt 枚举/资源模板/审批分级/分档/分页与 Node 目录一致；
   - completion 候选：Python 客户端经真实 server 拿到的值 = Node 补全引擎的值 = prompt 声明枚举。

B. 真实 server 的协议边界（node 可用时）：
   - initialize 协议版本协商、能力声明（completions/listPagination/experimental）；
   - resources/list 的行级分页/过滤/新鲜度、resources/read 的 freshnessState；
   - tools/call 错误的 _meta['browser-bridge/error'] 结构化恢复信息；
   - prompts/list 分页；completion/complete 参数与 free-form 语义；
   - 原始 stdio：批量数组 -32600、坏 JSON -32700、未知方法 -32601、通知不回帧。

没有 node 时整体 skip（不伪装通过）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import (  # noqa: E402
    TOOL_CATALOG,
    TOOL_CATALOG_META,
    BridgeError,
    McpToolClient,
    ToolCallError,
    classify_error_code,
    error_family,
    pagination_markers,
    retry_delay_ms,
    retry_plan,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("BB_NODE") or shutil.which("node")

SAMPLE_CODES = [
    "E_ARG_MISSING",
    "E_ARG_TYPE",
    "E_TOKEN_BAD_ARG",
    "E_HUMAN_GATE",
    "E_CANCELLED",
    "E_REQUEST_CANCELLED",
    "E_TIMEOUT",
    "E_DAEMON",
    "E_ENV",
    "E_NO_SESSION",
    "E_SESSION_STOPPED",
    "E_SESSION_BUSY",
    "E_RATE_LIMITED",
    "E_QUEUE_FULL",
    "E_STALE_REF",
    "E_NOT_FOUND",
    "E_OBSERVATION_STALE",
    "E_PROTOCOL_UNSUPPORTED",
    "E_LEDGER_IO",
    "E_INTERNAL",
    "E_MADE_UP_CODE",
]

RETRY_SAMPLES = [
    ["E_RATE_LIMITED", 1, 3],
    ["E_RATE_LIMITED", 2, 3],
    ["E_SESSION_BUSY", 1, 5],
    ["E_TIMEOUT", 1, 3],
    ["E_STALE_REF", 1, 3],
    ["E_HUMAN_GATE", 1, 3],
    ["E_CANCELLED", 2, 3],
    ["E_ARG_MISSING", 1, 2],
    ["E_DAEMON", 1, 4],
    ["E_MADE_UP", 1, 3],
]

NODE_DUMP_SCRIPT = """
import * as errorMap from './mcp/error-map.mjs';
import * as cursor from './mcp/cursor.mjs';
import * as completion from './mcp/completion.mjs';
import * as wire from './mcp/wire.mjs';
import * as prompts from './mcp/prompts.mjs';
import { listToolSpecs, toolTierSummary } from './sdk/tool-catalog.mjs';
import { PROMPT_DEFINITIONS } from './mcp/prompts.mjs';
import { COMPLETION_TEMPLATES } from './mcp/completion.mjs';

const codes = process.env.BB_CODES.split(',');
const retrySamples = JSON.parse(process.env.BB_RETRY_SAMPLES);
const tools = listToolSpecs();
const dump = {
  codes: Object.fromEntries(codes.map((code) => [code, errorMap.classifyErrorCode(code)])),
  delays: retrySamples.map(([code, attempt]) => [code, attempt, errorMap.retryDelayMs(attempt, { code })]),
  plans: retrySamples.map(([code, attempt, cap]) => [code, attempt, errorMap.retryPlan(code, { attempt, maxAttempts: cap })]),
  cursor: {
    encode: cursor.encodeCursor(42, { label: 'resources' }),
    decode: cursor.decodeCursor(cursor.encodeCursor(42, { label: 'resources' }), { label: 'resources' }),
    snapshot: cursor.cursorSnapshot(),
  },
  prompts: PROMPT_DEFINITIONS.map((prompt) => ({
    name: prompt.name,
    enumArgs: prompt.arguments
      .filter((argument) => Array.isArray(argument.enum))
      .map((argument) => ({ name: argument.name, values: [...argument.enum] })),
  })),
  completionEnums: PROMPT_DEFINITIONS.flatMap((prompt) => prompt.arguments
    .filter((argument) => Array.isArray(argument.enum))
    .map((argument) => ({
      prompt: prompt.name,
      argument: argument.name,
      values: completion.complete({ ref: { type: 'ref/prompt', name: prompt.name }, argument: { name: argument.name, value: '' } }).completion.values,
    }))),
  templates: COMPLETION_TEMPLATES.map((template) => ({ uriTemplate: template.uriTemplate, variable: template.variable })),
  tiers: toolTierSummary(),
  grades: Object.fromEntries(tools.map((tool) => [
    tool.name,
    tool.name === 'browser_update' ? 'mandatory' : (tool.approvalRequired ? 'confirm' : 'none'),
  ])),
  wire: {
    versions: wire.SUPPORTED_PROTOCOL_VERSIONS,
    defaultVersion: wire.DEFAULT_PROTOCOL_VERSION,
    methods: wire.WIRE_METHODS,
    errorNames: wire.JSONRPC_ERROR_NAMES,
    audit: wire.auditWireTables(),
    snapshot: wire.wireSnapshot(),
  },
  errorMapSnapshot: errorMap.errorMapSnapshot(),
  completionSnapshot: completion.completionSnapshot(),
};
process.stdout.write(JSON.stringify(dump));
"""


def base36(value):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = []
    while value:
        value, remainder = divmod(value, 36)
        out.append(digits[remainder])
    return "".join(reversed(out))


def free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class ThreeWayProtocolDepthTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env["BB_CODES"] = ",".join(SAMPLE_CODES)
        env["BB_RETRY_SAMPLES"] = json.dumps(RETRY_SAMPLES)
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", NODE_DUMP_SCRIPT],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=120,
        )
        if completed.returncode != 0:
            raise RuntimeError("node mcp 深度导出失败：" + str(completed.stderr)[:800])
        cls.node = json.loads(completed.stdout)
        cls.home = tempfile.mkdtemp(prefix="bb-py-proto-deep-")
        cls.client = McpToolClient(home=cls.home, node=NODE).connect()
        cls.mcp_tools = {tool["name"]: tool for tool in cls.client.list_mcp_tools()}

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    # -- A. 三方对账 ---------------------------------------------------------
    def test_01_wire_tables_three_way(self):
        wire = self.node["wire"]
        self.assertIn("2024-11-05", wire["versions"])
        self.assertIn("2025-03-26", wire["versions"])
        self.assertEqual(wire["defaultVersion"], "2024-11-05")
        self.assertTrue(wire["audit"]["ok"], wire["audit"]["errors"])
        for method in ("completion/complete", "resources/templates/list", "resources/list", "prompts/list"):
            self.assertIn(method, wire["methods"])
        self.assertEqual(wire["errorNames"]["-32602"], "INVALID_PARAMS")
        self.assertEqual(wire["errorNames"]["-32002"], "RESOURCE_NOT_FOUND")
        self.assertEqual(wire["snapshot"]["batch"], False)
        # 真实 server 的 initialize 能力与表一致（wire 扩展声明）
        experimental = self.client.capabilities["experimental"]
        self.assertIn("browser-bridge/wire", experimental)
        self.assertEqual(experimental["browser-bridge/wire"]["defaultProtocolVersion"], "2024-11-05")

    def test_02_error_classification_three_way(self):
        for code in SAMPLE_CODES:
            node = self.node["codes"][code]
            python = classify_error_code(code)
            self.assertEqual(python["category"], node["category"], code + ".category")
            self.assertEqual(python["retry"], node["retry"], code + ".retry")
            self.assertEqual(python["terminal"], node["terminal"], code + ".terminal")
            self.assertEqual(python["non_retryable"], node["nonRetryable"], code + ".nonRetryable")
            self.assertEqual(python["json_rpc_code"], node["jsonRpcCode"], code + ".jsonRpcCode")
            self.assertEqual(python["hint"], node["hint"], code + ".hint")

    def test_03_retry_plan_and_delay_three_way(self):
        for index, (code, attempt, cap) in enumerate(RETRY_SAMPLES):
            node_delay = self.node["delays"][index][2]
            self.assertEqual(retry_delay_ms(attempt, code=code), node_delay, f"{code}@{attempt}.delay")
            node_plan = self.node["plans"][index][2]
            python_plan = retry_plan(code, attempt=attempt, max_attempts=cap)
            for field_python, field_node in (
                ("retryable", "retryable"),
                ("attempt", "attempt"),
                ("max_attempts", "maxAttempts"),
                ("delay_ms", "delayMs"),
                ("reason", "reason"),
                ("category", "category"),
                ("needs_action", "needsAction"),
            ):
                self.assertEqual(python_plan[field_python], node_plan[field_node], f"{code}@{attempt}.{field_python}")
        # 规则表也有单点断言，防“两边一起错”
        self.assertEqual(retry_delay_ms(0, code="E_TIMEOUT"), retry_delay_ms(0, code="E_TIMEOUT"))
        self.assertEqual(retry_plan("E_RATE_LIMITED")["reason"], "retryable-transient")
        self.assertEqual(retry_plan("E_STALE_REF")["reason"], "needs-action")

    def test_04_cursor_format_cross_language(self):
        node_cursor = self.node["cursor"]
        self.assertEqual(node_cursor["encode"], "bb1.resources.16")
        self.assertEqual(node_cursor["decode"], {"offset": 42, "label": "resources"})
        self.assertEqual(base36(42), "16")
        python_cursor = "bb1.resources." + base36(42)
        self.assertEqual(python_cursor, node_cursor["encode"])
        self.assertEqual(node_cursor["snapshot"]["version"], "bb1")
        self.assertEqual(node_cursor["snapshot"]["methods"], ["resources/list", "resources/templates/list", "prompts/list"])
        # 真实 server 接受 Python 造的游标（跨语言游标可用）
        result = self.client.transport.request(
            "resources/list", {"limit": 1, "cursor": python_cursor}, timeout=10
        )
        # 偏移 42 远超资源数 → 空页且 hasMore=false（正常竞态语义，不报错）
        self.assertEqual(result.get("resources"), [])
        meta = result["_meta"]["browser-bridge/resources"]["listPagination"]
        self.assertFalse(meta["hasMore"])

    def test_05_prompt_enum_and_completion_three_way(self):
        node_prompts = {row["name"]: row for row in self.node["prompts"]}
        self.assertEqual(
            sorted(node_prompts),
            sorted(row["name"] for row in self.client.list_prompts()),
        )
        for expected in self.node["completionEnums"]:
            result = self.client.complete_prompt_argument(expected["prompt"], expected["argument"], "")
            self.assertEqual(result["values"], expected["values"], expected["prompt"] + "." + expected["argument"])
            self.assertEqual(result["total"], len(expected["values"]))
            declared = next(
                row for row in node_prompts[expected["prompt"]]["enumArgs"] if row["name"] == expected["argument"]
            )
            self.assertEqual(sorted(result["values"]), sorted(declared["values"]))
        # 真实 server 的 completion 与 Node 引擎一致（经 Python 客户端）
        direct = self.client.complete(
            {"type": "ref/prompt", "name": "har_analysis"},
            {"name": "focus", "value": ""},
        )
        self.assertEqual(direct["completion"]["values"], ["errors", "payloads", "replay", "timings"])
        self.assertEqual(direct["_meta"]["browser-bridge/completion"]["source"], "prompt-enum")

    def test_06_resource_templates_and_completion_three_way(self):
        template_variables = {row["uriTemplate"]: row["variable"] for row in self.node["templates"]}
        server_templates = self.client.transport.request("resources/templates/list", {}, timeout=10)
        server_names = {row["uriTemplate"] for row in server_templates.get("resourceTemplates") or []}
        self.assertEqual(set(template_variables), server_names)
        for uri_template in sorted(server_names):
            variable = template_variables[uri_template]
            result = self.client.complete({"type": "ref/resource", "uri": uri_template}, {"name": variable, "value": ""})
            meta = result["_meta"]["browser-bridge/completion"]
            self.assertIn(meta["source"], ("skill-references", "sessions"))
            self.assertIsInstance(result["completion"]["values"], list)
            # 变量名不匹配应被拒绝（-32602）
            wrong = "session" if variable != "session" else "name"
            with self.assertRaises(BridgeError) as caught:
                self.client.complete({"type": "ref/resource", "uri": uri_template}, {"name": wrong, "value": ""})
            self.assertEqual(caught.exception.data["code"], -32602)
        # 技能参考补全必须来自真实 skill/references 目录
        skill = self.client.complete(
            {"type": "ref/resource", "uri": "bridge://skill/references/{name}"},
            {"name": "name", "value": ""},
        )
        self.assertIn("environment.md", skill["completion"]["values"])

    def test_07_approval_grades_three_way(self):
        node_grades = self.node["grades"]
        self.assertEqual(len(node_grades), 92)
        self.assertEqual(node_grades["browser_update"], "mandatory")
        self.assertEqual(node_grades["browser_evaluate"], "confirm")
        self.assertEqual(node_grades["browser_observe"], "none")
        for name in TOOL_CATALOG_META["order"]:
            spec = TOOL_CATALOG[name]
            derived = "mandatory" if spec["approval_always"] else ("confirm" if spec["approval_required"] else "none")
            self.assertEqual(derived, node_grades[name], name + ".grade(python/node)")
            mcp_policy = self.mcp_tools[name]["_meta"]["browser-bridge/policy"]
            self.assertEqual(mcp_policy["approvalGrade"], derived, name + ".grade(mcp)")
            self.assertEqual(
                mcp_policy["approvalBypassable"],
                derived == "confirm",
                name + ".approvalBypassable",
            )
        by_grade = {"none": 0, "confirm": 0, "mandatory": 0}
        for grade in node_grades.values():
            by_grade[grade] += 1
        self.assertEqual(by_grade, {"none": 85, "confirm": 6, "mandatory": 1})
        list_meta = self.client.transport.request("tools/list", {}, timeout=10)["_meta"]
        self.assertEqual(list_meta["browser-bridge/policy"]["approvalGrades"], by_grade)
        self.assertEqual(list_meta["browser-bridge/approval"]["mandatory"], ["browser_update"])

    def test_08_tiers_and_pagination_three_way(self):
        node_tiers = self.node["tiers"]
        python_by_tier = {"read": 0, "mutate": 0, "destructive": 0}
        for name in TOOL_CATALOG_META["order"]:
            python_by_tier[TOOL_CATALOG[name]["tier"]] += 1
        self.assertEqual(python_by_tier, node_tiers["byTier"])
        self.assertEqual(node_tiers["total"], 92)
        self.assertEqual(len(node_tiers["approvals"]), 7)
        self.assertEqual(len(node_tiers["paginated"]), 8)
        for name in TOOL_CATALOG_META["order"]:
            self.assertEqual(bool(pagination_markers(name)["partial"]), name in node_tiers["paginated"], name)
        # 真实 server 的 resources 行级分页能力声明
        list_page = self.client.capabilities["resources"]["listPagination"]
        self.assertEqual(list_page["cursorParam"], "cursor")
        self.assertEqual(list_page["maxLimit"], 200)
        experimental = self.client.capabilities["experimental"]
        for key in (
            "browser-bridge/list-pagination",
            "browser-bridge/resource-index",
            "browser-bridge/approval",
            "browser-bridge/error-map",
            "browser-bridge/completions",
            "browser-bridge/wire",
        ):
            self.assertIn(key, experimental)
        self.assertEqual(experimental["browser-bridge/error-map"]["metaKey"], "browser-bridge/error")

    # -- B. 真实 server 行为 -------------------------------------------------
    def test_09_protocol_version_negotiation(self):
        from browser_bridge import StdioMcpTransport

        transport = StdioMcpTransport(
            [NODE, str(REPO_ROOT / "mcp" / "server.mjs")],
            cwd=str(REPO_ROOT),
            env={**os.environ, "BB_HOME": self.home},
            timeout=20,
        )
        try:
            known = transport.request(
                "initialize",
                {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "py-negotiate"}},
                timeout=20,
            )
            self.assertEqual(known["protocolVersion"], "2025-03-26")
            self.assertEqual(known["capabilities"]["experimental"]["browser-bridge/wire"]["negotiated"]["supported"], True)
            unknown = transport.request(
                "initialize",
                {"protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "py-negotiate"}},
                timeout=20,
            )
            self.assertEqual(unknown["protocolVersion"], "2024-11-05")
            negotiated = unknown["capabilities"]["experimental"]["browser-bridge/wire"]["negotiated"]
            self.assertEqual(negotiated["fallback"], True)
            self.assertEqual(negotiated["supported"], False)
            self.assertIn("completions", unknown["capabilities"])
        finally:
            transport.close()

    def test_10_resources_list_paging_and_freshness(self):
        full = self.client.list_resources_all(page_size=2)
        self.assertGreaterEqual(full["pages"], 2)
        self.assertGreaterEqual(len(full["resources"]), 5)
        uris = [row["uri"] for row in full["resources"]]
        self.assertIn("bridge://skill/SKILL.md", uris)
        self.assertIn("bridge://observation/latest", uris)

        first = self.client.transport.request("resources/list", {"limit": 2}, timeout=10)
        self.assertEqual(len(first["resources"]), 2)
        self.assertTrue(first.get("nextCursor"))
        page_meta = first["_meta"]["browser-bridge/resources"]["listPagination"]
        self.assertTrue(page_meta["hasMore"])
        second = self.client.transport.request("resources/list", {"limit": 2, "cursor": first["nextCursor"]}, timeout=10)
        self.assertNotEqual(second["resources"][0]["uri"], first["resources"][0]["uri"])

        filtered = self.client.transport.request("resources/list", {"kind": "skill-main"}, timeout=10)
        self.assertEqual([row["uri"] for row in filtered["resources"]], ["bridge://skill/SKILL.md"])
        self.assertEqual(filtered["_meta"]["browser-bridge/resources"]["index"]["total"], 1)

        bad = self.client.transport.request
        with self.assertRaises(BridgeError) as caught:
            bad("resources/list", {"cursor": "garbage"}, timeout=10)
        self.assertEqual(caught.exception.code, "E_RPC")
        self.assertEqual(caught.exception.data["code"], -32602)

        full_meta = self.client.transport.request("resources/list", {}, timeout=10)["_meta"]["browser-bridge/resources"]
        self.assertIn("freshness", full_meta)
        self.assertIn("byState", full_meta["freshness"])
        self.assertIn("windows", full_meta["freshness"])
        self.assertIn("total", full_meta["freshness"])
        static_kinds = full_meta["freshness"].get("windows", {})
        self.assertIn("freshMs", static_kinds)
        self.assertIn("index", full_meta)
        self.assertGreaterEqual(full_meta["index"]["total"], 5)

    def test_11_resource_read_freshness_static(self):
        result = self.client.read_resource("bridge://skill/SKILL.md")
        meta = result["_meta"]["browser-bridge/resource"]
        self.assertEqual(meta["freshnessState"], "static")
        self.assertEqual(meta["freshnessAction"], "use")
        self.assertTrue(meta["capabilities"]["subscribe"])
        # 动态资源无快照时是 -32002
        with self.assertRaises(BridgeError) as caught:
            self.client.read_resource("bridge://observation/latest")
        self.assertEqual(caught.exception.data["code"], -32002)

    def test_12_tools_call_error_recovery_meta(self):
        with self.assertRaises(ToolCallError) as caught:
            self.client.call_tool("browser_status", {})
        error = caught.exception
        self.assertEqual(error.code, "E_DAEMON")
        record = error.details["browser-bridge/error"]
        self.assertEqual(record["category"], "transport")
        self.assertEqual(record["terminal"], True)
        self.assertIn(record["retry"], ("no", "after-action"))
        self.assertEqual(record["retryable"], False)
        self.assertEqual(record["retryReason"], "non-retryable-code")
        self.assertEqual(record["jsonRpcCode"], -32603)
        self.assertEqual(record["tool"], "browser_status")

        # 本地 schema 校验在发请求前就拒绝（E_ARG_UNEXPECTED）
        with self.assertRaises(BridgeError) as caught_local:
            self.client.call_tool("browser_status", {"bogus": 1})
        self.assertEqual(caught_local.exception.code, "E_ARG_UNEXPECTED")
        # 跳过本地校验时由 server 运行时校验拒绝，_meta 带 validation 明细
        with self.assertRaises(ToolCallError) as caught_server:
            self.client.call_tool("browser_status", {"bogus": 1}, validate=False)
        self.assertEqual(caught_server.exception.code, "E_ARG_UNEXPECTED")
        self.assertIsInstance(caught_server.exception.details, list)
        self.assertEqual(caught_server.exception.details[0]["code"], "E_ARG_UNEXPECTED")

    def test_13_prompts_list_paging(self):
        first = self.client.transport.request("prompts/list", {"limit": 3}, timeout=10)
        self.assertEqual(len(first["prompts"]), 3)
        self.assertTrue(first.get("nextCursor"))
        second = self.client.transport.request("prompts/list", {"limit": 3, "cursor": first["nextCursor"]}, timeout=10)
        self.assertEqual(len(second["prompts"]), 3)
        names = [row["name"] for row in first["prompts"] + second["prompts"]]
        self.assertEqual(len(names), len(set(names)))
        meta = first["_meta"]["browser-bridge/prompts"]
        self.assertGreaterEqual(meta["total"], 9)
        self.assertEqual(meta["pagination"]["cursorParam"], "cursor")

    def test_14_completion_free_form_and_errors(self):
        free = self.client.complete(
            {"type": "ref/prompt", "name": "browser_task_brief"},
            {"name": "task", "value": "anything"},
        )
        self.assertEqual(free["completion"]["values"], [])
        self.assertTrue(free["_meta"]["browser-bridge/completion"]["freeForm"])
        with self.assertRaises(BridgeError) as caught:
            self.client.complete({"type": "ref/prompt", "name": "nope_prompt"}, {"name": "x", "value": ""})
        self.assertEqual(caught.exception.data["code"], -32602)
        with self.assertRaises(BridgeError):
            self.client.complete({"type": "ref/prompt", "name": "har_analysis"}, {"name": "not_declared", "value": ""})


@unittest.skipUnless(NODE, "需要 node（设置 BB_NODE 或把 node 加入 PATH）")
class RawWireBoundaryTest(unittest.TestCase):
    """直接驱动 stdio：验证信封层边界（批量/坏 JSON/未知方法/通知不回帧）。"""

    def setUp(self):
        import queue
        import threading

        self.queue = queue.Queue()
        self.home = tempfile.mkdtemp(prefix="bb-py-rawwire-")
        env = dict(os.environ)
        env["BB_HOME"] = self.home
        self.proc = subprocess.Popen(
            [NODE, str(REPO_ROOT / "mcp" / "server.mjs")],
            cwd=str(REPO_ROOT),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

        def _reader():
            for line in self.proc.stdout:
                text = line.strip()
                if not text:
                    continue
                try:
                    self.queue.put(json.loads(text))
                except ValueError:
                    continue

        self.reader = threading.Thread(target=_reader, name="raw-wire-reader", daemon=True)
        self.reader.start()

    def tearDown(self):
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            self.proc.kill()
        except OSError:
            pass

    def send_raw(self, text):
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def read_message(self, timeout=8.0):
        import queue

        try:
            return self.queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def assert_no_message(self, timeout=0.4):
        import queue

        with self.assertRaises(queue.Empty):
            self.queue.get(timeout=timeout)

    def test_batch_array_rejected_with_invalid_request(self):
        self.send_raw(json.dumps([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]))
        message = self.read_message()
        self.assertIsNotNone(message)
        self.assertIn("error", message)
        self.assertEqual(message["error"]["code"], -32600)
        self.assertIn("batch", message["error"]["message"])
        # 之后仍可正常服务
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}))
        reply = self.read_message()
        self.assertEqual(reply["id"], 2)
        self.assertEqual(reply["result"], {})

    def test_bad_json_is_parse_error(self):
        self.send_raw("{not json")
        message = self.read_message()
        self.assertEqual(message["error"]["code"], -32700)
        self.assertIsNone(message["id"])

    def test_unknown_method_is_method_not_found(self):
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 9, "method": "tools/nope", "params": {}}))
        message = self.read_message()
        self.assertEqual(message["error"]["code"], -32601)
        self.assertIn("Method not found", message["error"]["message"])

    def test_notification_gets_no_response(self):
        # 未知通知方法（含 notifications/initialized）不应回帧：后续 ping 的响应必须是第一帧。
        self.send_raw(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}))
        self.send_raw(json.dumps({"jsonrpc": "2.0", "method": "notifications/unknown", "params": {}}))
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 11, "method": "ping"}))
        message = self.read_message()
        self.assertEqual(message["id"], 11)
        self.assertEqual(message["result"], {})
        self.assert_no_message()

    def test_response_shaped_message_is_ignored(self):
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 5, "result": {"unexpected": True}}))
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 12, "method": "ping"}))
        message = self.read_message()
        self.assertEqual(message["id"], 12)
        self.assert_no_message()

    def test_invalid_params_shape_is_invalid_params(self):
        self.send_raw(json.dumps({"jsonrpc": "2.0", "id": 13, "method": "ping", "params": [1, 2]}))
        message = self.read_message()
        self.assertEqual(message["error"]["code"], -32602)


class PythonSideConstantsTest(unittest.TestCase):
    """不依赖 node 的本地断言（API 入口存在 + 错误族自洽）。"""

    def test_python_error_family_sanity(self):
        self.assertEqual(error_family("E_HUMAN_GATE"), "approval")
        self.assertEqual(error_family("E_RATE_LIMITED"), "session")
        self.assertEqual(error_family("E_MADE_UP"), "unknown")
        self.assertEqual(classify_error_code("E_RATE_LIMITED")["retry"], "transient")
        self.assertEqual(retry_plan("E_RATE_LIMITED")["retryable"], True)
        self.assertEqual(retry_plan("E_STALE_REF")["needs_action"], True)


if __name__ == "__main__":
    unittest.main()
