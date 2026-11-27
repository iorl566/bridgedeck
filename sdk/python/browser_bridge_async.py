"""BrowserBridge Python 异步客户端（asyncio）。

与同步的 :mod:`browser_bridge` 模块对齐，但整条工具链都是 ``await`` 的：
spawn ``node mcp/server.mjs`` 的 asyncio 子进程传输、全部 MCP 工具的 async 调用矩阵、
分页续读、取消、重试、prompts/resources/completion，以及订阅对账。

用法::

    import asyncio
    from browser_bridge_async import AsyncMcpToolClient

    async def main():
        async with AsyncMcpToolClient(home="~/.browser-bridge") as client:
            status = await client.call_tool("browser_status", {})
            page = await client.tools.browser_observe({})            # 全部 MCP 工具的矩阵访问
            pages = await client.call_tool_paged("browser_observe", {}, max_pages=3)
            await client.call_tool("browser_evaluate", {"expression": "1+1"}, approval=True)
            async for chunk in client.iter_tool_pages("browser_network_list", {}):
                ...
            result = await client.call_tool_with_retry("browser_status", {}, max_attempts=3)
            await client.sync_resource_subscriptions(["bridge://observation/latest"])

    asyncio.run(main())

零第三方依赖：只用 Python 标准库（asyncio / json / subprocess / os / time / uuid），
工具目录/校验/错误恢复语义全部复用同步模块 :mod:`browser_bridge`（单一来源，避免两边漂移）。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Sequence, Tuple, Union

from browser_bridge import (  # noqa: E402 - 同目录模块；测试通过 sys.path 注入
    APPROVAL_CONFIRMED,
    APPROVAL_ENV,
    APPROVAL_META_KEY,
    DEFAULT_PAGE_LIMIT,
    MCP_PROTOCOL_VERSION,
    MCP_SERVER_PATH,
    REPO_ROOT,
    RETRY_POLICY,
    TOOL_APPROVAL_ALWAYS,
    TOOL_CATALOG,
    TOOL_CATALOG_META,
    BridgeError,
    ProgressTracker,
    ToolCallError,
    _payload_from_tool_result,
    default_home,
    next_page_params,
    pagination_markers,
    retry_delay_ms,
    retry_plan,
    tool_coverage,
    tool_spec,
    validate_tool_args,
)

ASYNC_SDK_VERSION = "0.1.0"
ASYNC_CLIENT_INFO = {"name": "browser-bridge-python-async-sdk", "version": ASYNC_SDK_VERSION}

# 异步客户端默认超时（与同步客户端一致，单工具仍按 TOOL_CATALOG 的 timeout_ms 收窄）。
DEFAULT_TIMEOUT = 60.0
CONNECT_TIMEOUT = 12.0

# 传输层错误码（与同步 StdioMcpTransport 对齐，error-map 可直接分类）。
TRANSPORT_ERROR_CODES = ("E_DISCONNECTED", "E_TIMEOUT", "E_RPC", "E_CANCELLED", "E_ENV")

# asyncio StreamReader 单行上限：MCP 一行 JSON 可能很大（tools/list 含全部工具 schema、
# resources/read 单页 64KiB 字符再 JSON 转义）。默认 64KiB 会触发 LimitOverrunError，
# 这里放宽到 8MiB（与 server 侧 maxBuffer 同量级），仍保持有界。
STREAM_LIMIT_BYTES = 8 * 1024 * 1024

# 取消传播：这些错误不应被 call_tool_with_retry 当作可重试。
NON_RETRYABLE_FOR_ASYNC = ("E_CANCELLED", "E_REQUEST_CANCELLED", "E_HUMAN_GATE", "E_ARG_MISSING", "E_ARG_TYPE", "E_ARG_ENUM", "E_ARG_UNEXPECTED")


# ---------------------------------------------------------------------------
# 小工具函数
# ---------------------------------------------------------------------------

async def _maybe_await(value: Any) -> Any:
    """兼容“回调既可能是同步函数也可能是 async 函数”的调用点。"""
    if inspect.isawaitable(value):
        return await value
    return value


def _elapsed_ms(started: float) -> float:
    return round((time.monotonic() - started) * 1000.0, 3)


def _new_progress_token() -> str:
    return "bb-py-async-" + uuid.uuid4().hex[:16]


def _emit_progress(callback: Optional[Any], event: Dict[str, Any]) -> None:
    """best-effort 进度回调：回调异常不能中断工具调用（与同步实现一致）。"""
    if callback is None:
        return
    try:
        result = callback(dict(event))
        if inspect.isawaitable(result):
            # 同步阶段里无法 await；把协程丢弃会告警，因此明确驱动/忽略。
            if hasattr(result, "close"):
                result.close()
    except Exception:  # noqa: BLE001 - 回调失败不影响调用
        pass


def approval_disabled(env: Optional[Dict[str, str]] = None) -> bool:
    """BB_MCP_APPROVAL=off/0/false/disabled 时客户端本地审批闸门放行（browser_update 例外）。"""
    value = str((env or os.environ).get(APPROVAL_ENV, "")).strip().lower()
    return value in ("off", "0", "false", "disabled")


def summarize_progress(events: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """把事件序列压成可断言的摘要（阶段顺序 / 终态 / 重试与重连次数）。"""
    list_events = [event for event in (events or []) if isinstance(event, dict)]
    phases = [str(event.get("phase")) for event in list_events]
    terminal = [phase for phase in phases if phase in ("done", "error", "cancelled")]
    return {
        "events": len(list_events),
        "phases": phases,
        "final_phase": phases[-1] if phases else None,
        "started": "start" in phases,
        "finished": bool(terminal),
        "terminal": terminal[-1] if terminal else None,
        "progress_samples": phases.count("progress"),
        "retries": phases.count("retry"),
        "reconnects": phases.count("reconnect"),
    }


def plan_subscription_changes(desired: Iterable[str], current: Iterable[str]) -> Dict[str, Any]:
    """声明式订阅对账（与 Node SDK 的 planSubscriptionChanges 同语义）。

    返回 ``{to_subscribe, to_unsubscribe, unchanged, desired, current, ops}``：
    两边都按去重后的 URI 集合处理，输出按字典序，幂等可重放。
    """
    desired_set = {str(uri).strip() for uri in desired or [] if str(uri).strip()}
    current_set = {str(uri).strip() for uri in current or [] if str(uri).strip()}
    to_subscribe = sorted(desired_set - current_set)
    to_unsubscribe = sorted(current_set - desired_set)
    unchanged = sorted(desired_set & current_set)
    return {
        "to_subscribe": to_subscribe,
        "to_unsubscribe": to_unsubscribe,
        "unchanged": unchanged,
        "desired": len(desired_set),
        "current": len(current_set),
        "ops": len(to_subscribe) + len(to_unsubscribe),
    }


def diff_subscriptions(before: Iterable[str], after: Iterable[str]) -> Dict[str, Any]:
    """两次订阅集合的差量（顺序保留输入顺序，便于看出时间序）。"""
    before_list = [str(uri) for uri in before or []]
    after_list = [str(uri) for uri in after or []]
    before_set = set(before_list)
    after_set = set(after_list)
    added = [uri for uri in after_list if uri not in before_set]
    removed = [uri for uri in before_list if uri not in after_set]
    kept = [uri for uri in after_list if uri in before_set]
    return {
        "added": added,
        "removed": removed,
        "kept": kept,
        "counts": {
            "before": len(before_list),
            "after": len(after_list),
            "added": len(added),
            "removed": len(removed),
            "kept": len(kept),
            "churn": len(added) + len(removed),
        },
        "unchanged": not added and not removed,
    }


def tool_matrix_rows() -> List[Dict[str, Any]]:
    """全部 MCP 工具矩阵的静态行（tier / 审批 / 超时 / 分页 / 方法映射）。"""
    rows: List[Dict[str, Any]] = []
    order = TOOL_CATALOG_META.get("order") or tuple(TOOL_CATALOG.keys())
    for name in order:
        spec = TOOL_CATALOG.get(name)
        if not spec:
            continue
        pagination = spec.get("pagination")
        rows.append({
            "name": name,
            "tier": spec.get("tier"),
            "approval_required": bool(spec.get("approval_required")),
            "approval_always": bool(spec.get("approval_always")),
            "timeout_ms": int(spec.get("timeout_ms") or 60_000),
            "idempotent": bool(spec.get("idempotent")),
            "open_world": bool(spec.get("open_world")),
            "methods": list(spec.get("methods") or ()),
            "partial": bool(pagination and pagination.get("partial")),
            "pagination": pagination,
        })
    return rows


def async_tool_matrix_snapshot() -> Dict[str, Any]:
    """异步工具矩阵能力快照（测试/诊断用；不发起连接）。"""
    rows = tool_matrix_rows()
    by_tier: Dict[str, int] = {}
    for row in rows:
        by_tier[row["tier"]] = by_tier.get(row["tier"], 0) + 1
    return {
        "supported": True,
        "version": ASYNC_SDK_VERSION,
        "total": len(rows),
        "by_tier": by_tier,
        "approval_required": [row["name"] for row in rows if row["approval_required"]],
        "approval_always": list(TOOL_APPROVAL_ALWAYS),
        "paginated": [row["name"] for row in rows if row["partial"]],
        "timeout_range_ms": [
            min((row["timeout_ms"] for row in rows), default=0),
            max((row["timeout_ms"] for row in rows), default=0),
        ],
        "client_methods": [
            "connect",
            "close",
            "call_tool",
            "call_tool_detailed",
            "call_tool_paged",
            "call_tool_with_retry",
            "iter_tool_pages",
            "call_tools",
            "sync_resource_subscriptions",
        ],
        "catalog_protocol": TOOL_CATALOG_META.get("protocol"),
    }


def audit_async_matrix() -> Dict[str, Any]:
    """异步矩阵硬审计（单测/CI 用）：全部工具无缺项、字段自洽、分页标记可派生。

    @returns ``{ok, errors, total, by_tier, paginated, approval_required}``
    """
    errors: List[Dict[str, str]] = []

    def push(code: str, target: str, message: str) -> None:
        errors.append({"code": code, "target": target, "message": message})

    rows = tool_matrix_rows()
    expected_order = tuple(TOOL_CATALOG_META.get("order") or ())
    expected_total = len(TOOL_CATALOG)
    if len(rows) != expected_total:
        push("matrix-total", "<all>", f"工具矩阵应有 {expected_total} 项，实际 {len(rows)}")
    if expected_order and tuple(row["name"] for row in rows) != expected_order:
        push("matrix-order", "<all>", "工具矩阵顺序与 catalog order 不一致")
    seen = set()
    paginated = 0
    approvals = 0
    for row in rows:
        name = row["name"]
        if name in seen:
            push("matrix-duplicate", name, "工具名重复")
        seen.add(name)
        if row["tier"] not in ("read", "mutate", "destructive"):
            push("matrix-tier", name, f"未知 tier：{row['tier']}")
        if not (1_000 <= row["timeout_ms"] <= 900_000):
            push("matrix-timeout", name, f"timeout_ms 越界：{row['timeout_ms']}")
        if not row["methods"]:
            # 本地工具（browser_update_state / browser_install_skill / browser_video_trim ...）
            # 不映射 daemon 协议方法，methods 为空是合法的；这里只要求其它工具非空。
            if row["tier"] == "read" and not row["idempotent"]:
                push("matrix-methods", name, "无协议方法的 read 工具必须幂等")
        if row["approval_required"]:
            approvals += 1
            if row["tier"] != "destructive":
                push("matrix-approval", name, "要求审批的工具必须是 destructive 级")
        if row["partial"]:
            paginated += 1
            markers = pagination_markers(name)
            if not markers.get("partial"):
                push("matrix-pagination", name, "catalog 标了 partial 但 pagination_markers 不可派生")
            expected_keys = ("partial", "methods", "cursorParam", "resultFields")
            for key in expected_keys:
                if key not in markers:
                    push("matrix-pagination", name, f"分页标记缺 {key}")
    for name in TOOL_APPROVAL_ALWAYS:
        spec = TOOL_CATALOG.get(name)
        if spec is None:
            push("matrix-always", name, "APPROVAL_ALWAYS 工具不存在")
        elif not spec.get("approval_always"):
            push("matrix-always", name, "APPROVAL_ALWAYS 工具的 approval_always 不是 True")
    if TOOL_CATALOG_META.get("tool_count") != len(rows):
        push("matrix-meta", "<catalog>", "TOOL_CATALOG_META.tool_count 与矩阵行数不一致")
    snapshot = async_tool_matrix_snapshot()
    for method in snapshot["client_methods"]:
        if not hasattr(AsyncMcpToolClient, method):
            push("matrix-client", method, "AsyncMcpToolClient 缺少方法")
    return {
        "ok": not errors,
        "errors": errors,
        "total": len(rows),
        "by_tier": snapshot["by_tier"],
        "paginated": paginated,
        "approval_required": approvals,
        "version": ASYNC_SDK_VERSION,
    }


# ---------------------------------------------------------------------------
# asyncio stdio 传输
# ---------------------------------------------------------------------------

class AsyncStdioMcpTransport:
    """以 newline-delimited JSON-RPC 2.0 与 ``node mcp/server.mjs`` 通信（asyncio 版）。

    与同步 ``StdioMcpTransport`` 的语义对齐：
      - 单读任务（``asyncio.Task``）+ 每个请求一个 ``Future``；
      - 超时会 kill 子进程并抛 ``E_TIMEOUT``（半开管道不阻塞事件循环）；
      - ``cancel(request_id)`` 发 ``notifications/cancelled`` 并立刻以 ``E_CANCELLED``
        结束等待（server 按 MCP 规范不再回该请求的响应）；
      - server→client 通知（progress / resources updated）分发给 ``add_notification_handler``
        注册的回调；回调既可以是同步函数也可以是 async 函数（async 会被调度执行）。
    """

    def __init__(self, command: List[str], cwd: Optional[Union[str, Path]] = None,
                 env: Optional[Dict[str, str]] = None, timeout: float = DEFAULT_TIMEOUT) -> None:
        if not command:
            raise BridgeError("E_ENV", "AsyncStdioMcpTransport 需要启动命令")
        self.command = [str(item) for item in command]
        self.cwd = str(cwd) if cwd else None
        self.env = dict(env or os.environ)
        self.timeout = float(timeout)
        self._proc: Optional[Any] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._pending: Dict[int, asyncio.Future] = {}
        self._listeners: List[Any] = []
        self._seq = 0
        self._closed = False
        self._exited = False
        self._write_lock: Optional[asyncio.Lock] = None
        self._started_at: Optional[float] = None

    # -- 生命周期 -----------------------------------------------------------
    @property
    def alive(self) -> bool:
        return self._proc is not None and not self._closed and not self._exited

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    async def start(self) -> "AsyncStdioMcpTransport":
        """启动子进程（幂等；失败抛 E_ENV）。"""
        if self._proc is not None:
            return self
        if self._closed:
            raise BridgeError("E_DISCONNECTED", "MCP 传输已关闭")
        loop = asyncio.get_running_loop()
        self._write_lock = asyncio.Lock()
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self.command,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=STREAM_LIMIT_BYTES,
            )
        except (OSError, ValueError) as error:
            raise BridgeError("E_ENV", f"启动 MCP server 失败（需要 node）：{error}") from error
        self._started_at = time.monotonic()
        self._reader_task = loop.create_task(self._read_loop(), name="bb-async-mcp-reader")
        return self

    async def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if "method" in message and "id" not in message:
                    self._dispatch_notification(message)
                    continue
                future = self._pending.pop(message.get("id"), None)
                if future is None or future.done():
                    continue
                if message.get("error") is not None:
                    error = message["error"] if isinstance(message["error"], dict) else {"message": str(message["error"])}
                    future.set_exception(BridgeError(
                        "E_RPC", str(error.get("message") or "mcp rpc failed"), data=error,
                    ))
                else:
                    future.set_result(message.get("result"))
        except (OSError, ValueError):
            pass
        finally:
            self._exited = True
            pending = list(self._pending.values())
            self._pending.clear()
            for future in pending:
                if not future.done():
                    future.set_exception(BridgeError("E_DISCONNECTED", "MCP server 已退出"))

    def _dispatch_notification(self, message: Dict[str, Any]) -> None:
        for listener in list(self._listeners):
            try:
                result = listener(message)
                if inspect.isawaitable(result):
                    asyncio.ensure_future(_maybe_await(result))
            except Exception:  # noqa: BLE001 - 通知回调失败不能影响读循环
                pass

    def add_notification_handler(self, handler: Any) -> Any:
        if not callable(handler):
            raise BridgeError("E_ARG_TYPE", "通知回调必须可调用")
        self._listeners.append(handler)
        return handler

    def remove_notification_handler(self, handler: Any) -> bool:
        for index, listener in enumerate(self._listeners):
            if listener is handler:
                del self._listeners[index]
                return True
        return False

    # -- 请求/通知/取消 -----------------------------------------------------
    async def _write_line(self, payload: Dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise BridgeError("E_DISCONNECTED", "MCP 连接已关闭")
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            if self._write_lock is not None:
                async with self._write_lock:
                    proc.stdin.write(data)
                    await proc.stdin.drain()
            else:
                proc.stdin.write(data)
                await proc.stdin.drain()
        except (OSError, ValueError) as error:
            raise BridgeError("E_DISCONNECTED", f"MCP 写入失败：{error}") from error

    async def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        await self.start()
        await self._write_line({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def cancel(self, request_id: int, reason: str = "") -> bool:
        """取消在途请求：唤醒等待方为 E_CANCELLED，并调度发送 notifications/cancelled。"""
        future = self._pending.pop(request_id, None)
        if future is None or future.done():
            return False
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._send_cancel(request_id, reason))
        except RuntimeError:
            # 没有运行中的事件循环（极端情况）：只唤醒等待方，通知尽力而为。
            pass
        future.set_exception(BridgeError(
            "E_CANCELLED",
            f"MCP 请求 {request_id} 已被取消" + (f"：{reason}" if reason else ""),
            data={"requestId": request_id, "reason": str(reason or "")},
        ))
        return True

    async def _send_cancel(self, request_id: int, reason: str) -> None:
        try:
            await self.notify("notifications/cancelled", {"requestId": request_id, "reason": str(reason or "")})
        except (BridgeError, OSError, ValueError):
            pass

    async def request(self, method: str, params: Optional[Dict[str, Any]] = None,
                      timeout: Optional[float] = None, on_start: Optional[Any] = None) -> Any:
        """发请求并等待响应；超时 kill 子进程并抛 E_TIMEOUT。"""
        await self.start()
        if self._closed or self._proc is None:
            raise BridgeError("E_DISCONNECTED", "MCP 连接已关闭")
        loop = asyncio.get_running_loop()
        wait = float(timeout or self.timeout)
        self._seq += 1
        request_id = self._seq
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = future
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        try:
            await self._write_line(payload)
        except BridgeError:
            self._pending.pop(request_id, None)
            raise
        if on_start is not None:
            try:
                result = on_start(request_id)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                self._pending.pop(request_id, None)
                if not future.done():
                    future.cancel()
                raise
        try:
            return await asyncio.wait_for(future, wait)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            await self._abort()
            raise BridgeError("E_TIMEOUT", f"MCP {method} 超过 {wait:.2f}s 未返回") from None

    async def _abort(self) -> None:
        self._closed = True
        self._exited = True
        proc = self._proc
        self._proc = None
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(BridgeError("E_DISCONNECTED", "MCP 传输已中止"))
        if proc is not None:
            try:
                proc.kill()
            except (OSError, ProcessLookupError):
                pass
            try:
                await proc.wait()
            except (OSError, ProcessLookupError):
                pass

    async def close(self) -> None:
        """关闭子进程（幂等）：先关 stdin，再 terminate/kill，并唤醒所有等待方。"""
        self._closed = True
        proc = self._proc
        self._proc = None
        pending = list(self._pending.values())
        self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(BridgeError("E_DISCONNECTED", "MCP 传输已关闭"))
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            proc.terminate()
        except (OSError, ProcessLookupError):
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except (asyncio.TimeoutError, OSError, ProcessLookupError):
            try:
                proc.kill()
            except (OSError, ProcessLookupError):
                pass
            try:
                await proc.wait()
            except (OSError, ProcessLookupError):
                pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - 关闭阶段吞掉读任务异常
                pass
            self._reader_task = None

    def snapshot(self) -> Dict[str, Any]:
        return {
            "alive": self.alive,
            "closed": self._closed,
            "exited": self._exited,
            "pid": getattr(self._proc, "pid", None),
            "started_at": None if self._started_at is None else time.time() - (time.monotonic() - self._started_at),
            "uptime_ms": 0.0 if self._started_at is None else round((time.monotonic() - self._started_at) * 1000.0, 3),
            "requests": self._seq,
            "pending": len(self._pending),
            "listeners": len(self._listeners),
        }


# ---------------------------------------------------------------------------
# 取消作用域（asyncio 版）
# ---------------------------------------------------------------------------

class AsyncCancellationScope:
    """把取消请求转交给在途工具调用的轻量作用域（asyncio 版）。

    用法::

        scope = AsyncCancellationScope()
        task = asyncio.create_task(client.call_tool("browser_observe", {}, cancel_scope=scope))
        await asyncio.sleep(0.1)
        await scope.cancel("user aborted")
    """

    def __init__(self) -> None:
        self._request_id: Optional[int] = None
        self._cancel_fn: Optional[Any] = None
        self._cancelled = False
        self._reason = ""
        self._callbacks: List[Any] = []

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def reason(self) -> str:
        return self._reason

    @property
    def request_id(self) -> Optional[int]:
        return self._request_id

    def attach(self, request_id: int, cancel_fn: Optional[Any] = None) -> None:
        self._request_id = request_id
        if cancel_fn is not None:
            self._cancel_fn = cancel_fn

    def detach(self) -> None:
        self._request_id = None
        self._cancel_fn = None

    def add_callback(self, callback: Any) -> Any:
        if not callable(callback):
            raise BridgeError("E_ARG_TYPE", "取消回调必须可调用")
        self._callbacks.append(callback)
        return callback

    async def cancel(self, reason: str = "") -> bool:
        """取消在途请求；已取消/尚未 attach 时返回 False（幂等）。"""
        if self._cancelled:
            return False
        self._cancelled = True
        self._reason = str(reason or "")
        handled = False
        if self._request_id is not None and self._cancel_fn is not None:
            try:
                handled = bool(await _maybe_await(self._cancel_fn(self._request_id, self._reason)))
            except Exception:  # noqa: BLE001 - 取消失败不应让调用方崩溃
                handled = False
        for callback in list(self._callbacks):
            try:
                await _maybe_await(callback(self))
            except Exception:  # noqa: BLE001 - 回调失败不影响取消语义
                pass
        return handled

    def cancel_nowait(self, reason: str = "") -> None:
        """在非 async 上下文里调度取消（供信号处理/定时器使用）。"""
        self._cancelled = True
        self._reason = str(reason or "")
        if self._request_id is not None and self._cancel_fn is not None:
            try:
                asyncio.get_running_loop().create_task(_maybe_await(self._cancel_fn(self._request_id, self._reason)))
            except RuntimeError:
                pass

    async def __aenter__(self) -> "AsyncCancellationScope":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self.detach()


# ---------------------------------------------------------------------------
# 全部 MCP 工具矩阵
# ---------------------------------------------------------------------------

class AsyncToolMatrix:
    """全部 MCP 工具的属性式调用矩阵：``await client.tools.browser_observe({})``。

    - 每个工具名都是 :class:`AsyncMcpToolClient` 上的一个 async 方法；
    - ``call(name, ...)`` 动态调用；``paged(name, ...)`` 自动续读；``with_retry(name, ...)`` 带退避；
    - ``coverage()``/``matrix()`` 给出每工具的 tier/审批/超时/分页等矩阵元数据；
    - 未知工具名抛 ``AttributeError``（不是静默返回 None）。
    """

    def __init__(self, client: "AsyncMcpToolClient") -> None:
        self._client = client
        self._names = tuple(TOOL_CATALOG_META.get("order") or TOOL_CATALOG.keys())
        self._name_set = set(self._names)

    def __len__(self) -> int:
        return len(self._names)

    def __iter__(self):
        return iter(self._names)

    def __contains__(self, name: object) -> bool:
        return str(name) in self._name_set

    def names(self) -> Tuple[str, ...]:
        return self._names

    def spec(self, name: str) -> Dict[str, Any]:
        spec = TOOL_CATALOG.get(str(name))
        if spec is None:
            raise BridgeError("E_ARG_UNEXPECTED", f"未知 MCP 工具：{name}")
        return spec

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in self._name_set:
            raise AttributeError(f"未知 MCP 工具：{name}")
        async def _invoke(args: Optional[Dict[str, Any]] = None, **options: Any) -> Any:
            return await self._client.call_tool(name, args or {}, **options)
        _invoke.__name__ = name
        _invoke.__doc__ = f"异步调用 {name}（等价于 client.call_tool({name!r}, args, **options)）。"
        return _invoke

    async def call(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> Any:
        return await self._client.call_tool(name, args or {}, **options)

    async def detailed(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> Dict[str, Any]:
        return await self._client.call_tool_detailed(name, args or {}, **options)

    async def paged(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> List[Any]:
        return await self._client.call_tool_paged(name, args or {}, **options)

    async def with_retry(self, name: str, args: Optional[Dict[str, Any]] = None, **options: Any) -> Any:
        return await self._client.call_tool_with_retry(name, args or {}, **options)

    def matrix(self) -> Dict[str, Dict[str, Any]]:
        return {row["name"]: dict(row) for row in tool_matrix_rows()}

    def coverage(self) -> Dict[str, Any]:
        rows = tool_matrix_rows()
        by_tier: Dict[str, int] = {}
        for row in rows:
            by_tier[row["tier"]] = by_tier.get(row["tier"], 0) + 1
        return {
            "total": len(rows),
            "by_tier": by_tier,
            "approval_required": [row["name"] for row in rows if row["approval_required"]],
            "paginated": [row["name"] for row in rows if row["partial"]],
            "missing": [name for name in self._names if name not in TOOL_CATALOG],
        }


# ---------------------------------------------------------------------------
# 异步 MCP 工具客户端
# ---------------------------------------------------------------------------

class AsyncMcpToolClient:
    """asyncio 版 MCP 工具客户端：全部 MCP 工具 + 分页 + 取消 + 重试 + 订阅对账。

    传输可注入（``transport=``）便于单测；不注入时按 ``node mcp/server.mjs`` 启动。
    工具目录/参数校验/错误恢复建议直接复用同步模块（单一来源）。
    """

    def __init__(self, home: Optional[Union[str, Path]] = None, timeout: float = DEFAULT_TIMEOUT,
                 node: Optional[str] = None, transport: Any = None,
                 client_info: Optional[Dict[str, Any]] = None) -> None:
        self.home = Path(home).expanduser() if home else default_home()
        self.timeout = float(timeout)
        self.node = node or os.environ.get("BB_NODE") or shutil.which("node")
        self._transport = transport
        self.client_info = dict(client_info or ASYNC_CLIENT_INFO)
        self.server_info: Optional[Dict[str, Any]] = None
        self.capabilities: Dict[str, Any] = {}
        self.protocol_version: Optional[str] = None
        self.connected = False
        self._closed = False
        self.subscriptions: set = set()
        self._resource_handlers: List[Any] = []
        self._tools = AsyncToolMatrix(self)

    # -- 传输/生命周期 ------------------------------------------------------
    @property
    def tools(self) -> AsyncToolMatrix:
        return self._tools

    @property
    def transport(self) -> Any:
        if self._closed:
            raise BridgeError("E_DISCONNECTED", "MCP 异步客户端已关闭：先 await connect() 重新握手")
        if self._transport is None:
            if not self.node:
                raise BridgeError("E_ENV", "找不到 node：设置 BB_NODE 或把 node 加进 PATH")
            if not Path(MCP_SERVER_PATH).exists():
                raise BridgeError("E_ENV", f"找不到 MCP server：{MCP_SERVER_PATH}")
            env = dict(os.environ)
            env["BB_HOME"] = str(self.home)
            self._transport = AsyncStdioMcpTransport(
                [str(self.node), str(MCP_SERVER_PATH)],
                cwd=str(REPO_ROOT),
                env=env,
                timeout=self.timeout,
            )
        return self._transport

    async def connect(self) -> "AsyncMcpToolClient":
        """initialize 握手（幂等）：重复调用返回 self。"""
        if self.connected:
            return self
        self._closed = False
        result = await self.transport.request("initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": dict(self.client_info),
        }, timeout=self.timeout)
        if isinstance(result, dict):
            self.server_info = result.get("serverInfo") or {}
            self.capabilities = result.get("capabilities") or {}
            self.protocol_version = result.get("protocolVersion")
        try:
            await self.transport.notify("notifications/initialized", {})
        except BridgeError:
            pass
        self.connected = True
        return self

    async def close(self) -> None:
        transport = self._transport
        self._transport = None
        self.connected = False
        self._closed = True
        self.subscriptions.clear()
        self._resource_handlers.clear()
        if transport is not None:
            closer = getattr(transport, "close", None)
            if callable(closer):
                await _maybe_await(closer())

    async def __aenter__(self) -> "AsyncMcpToolClient":
        return await self.connect()

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    def transport_snapshot(self) -> Dict[str, Any]:
        snapshot = getattr(self._transport, "snapshot", None)
        return {
            "connected": self.connected,
            "closed": self._closed,
            "protocol_version": self.protocol_version,
            "server_info": self.server_info,
            "subscriptions": sorted(self.subscriptions),
            "handlers": len(self._resource_handlers),
            "transport": snapshot() if callable(snapshot) else None,
        }

    # -- 只读 MCP 方法 ------------------------------------------------------
    async def ping(self) -> Any:
        return await self.transport.request("ping", {}, timeout=self.timeout)

    async def list_mcp_tools(self) -> List[Dict[str, Any]]:
        result = await self.transport.request("tools/list", {}, timeout=self.timeout)
        return list((result or {}).get("tools") or [])

    async def list_prompts(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        if limit:
            params["limit"] = limit
        result = await self.transport.request("prompts/list", params, timeout=self.timeout)
        return list((result or {}).get("prompts") or [])

    async def prompt_list_page(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        if limit:
            params["limit"] = limit
        return await self.transport.request("prompts/list", params, timeout=self.timeout) or {}

    async def prompt_versions(self) -> List[Dict[str, Any]]:
        """提取 prompts/list 里的版本元数据（name/version/fingerprint/stability）。"""
        prompts = await self.list_prompts()
        rows = []
        for prompt in prompts:
            meta = (prompt.get("_meta") or {}).get("browser-bridge/prompt-version") or {}
            rows.append({
                "name": prompt.get("name"),
                "version": meta.get("version"),
                "fingerprint": meta.get("fingerprint"),
                "stability": meta.get("stability"),
            })
        return rows

    async def get_prompt(self, name: str, arguments: Optional[Dict[str, Any]] = None,
                         version: Optional[str] = None) -> Dict[str, Any]:
        """prompts/get；可选 version（服务端不支持时按当前版本渲染并标 fallback）。"""
        params: Dict[str, Any] = {"name": str(name), "arguments": arguments or {}}
        if version is not None:
            params["version"] = str(version)
        result = await self.transport.request("prompts/get", params, timeout=self.timeout)
        return result or {}

    async def completion(self, ref: Dict[str, Any], argument: Dict[str, Any],
                         cursor: Optional[str] = None, limit: Optional[int] = None,
                         context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"ref": ref, "argument": argument}
        if cursor is not None:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = limit
        if context is not None:
            params["context"] = context
        result = await self.transport.request("completion/complete", params, timeout=self.timeout)
        return result or {}

    async def complete_prompt_argument(self, prompt: str, argument: str, value: str = "",
                                       cursor: Optional[str] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        return await self.completion(
            {"type": "ref/prompt", "name": str(prompt)},
            {"name": str(argument), "value": str(value)},
            cursor=cursor, limit=limit,
        )

    async def complete_resource_argument(self, uri_template: str, argument: str, value: str = "",
                                         cursor: Optional[str] = None, limit: Optional[int] = None) -> Dict[str, Any]:
        return await self.completion(
            {"type": "ref/resource", "uri": str(uri_template)},
            {"name": str(argument), "value": str(value)},
            cursor=cursor, limit=limit,
        )

    def supports_completion(self) -> bool:
        return bool(self.capabilities.get("completions") is not None or self.capabilities.get("experimental", {}).get("browser-bridge/completions"))

    async def resource_list_page(self, cursor: Optional[str] = None, limit: Optional[int] = None,
                                 query: Optional[str] = None, kind: Optional[str] = None,
                                 mime_type: Optional[str] = None, sort: Optional[str] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        if limit:
            params["limit"] = limit
        if query:
            params["query"] = query
        if kind:
            params["kind"] = kind
        if mime_type:
            params["mimeType"] = mime_type
        if sort:
            params["sort"] = sort
        return await self.transport.request("resources/list", params, timeout=self.timeout) or {}

    async def list_resources(self, cursor: Optional[str] = None, limit: Optional[int] = None,
                             query: Optional[str] = None, kind: Optional[str] = None,
                             mime_type: Optional[str] = None, sort: Optional[str] = None) -> List[Dict[str, Any]]:
        result = await self.resource_list_page(cursor=cursor, limit=limit, query=query, kind=kind,
                                               mime_type=mime_type, sort=sort)
        return list(result.get("resources") or [])

    async def read_resource(self, uri: str) -> Dict[str, Any]:
        result = await self.transport.request("resources/read", {"uri": str(uri)}, timeout=self.timeout)
        return result or {}

    async def list_resource_templates(self) -> List[Dict[str, Any]]:
        result = await self.transport.request("resources/templates/list", {}, timeout=self.timeout)
        return list((result or {}).get("resourceTemplates") or [])

    async def list_resources_all(self, max_pages: int = 20, page_size: int = 100) -> Dict[str, Any]:
        """resources/list 全量拉取（按 nextCursor 续读；服务端默认全量，分页是可选优化）。"""
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        resources: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        pages = 0
        while pages < max_pages:
            result = await self.resource_list_page(cursor=cursor, limit=page_size)
            resources.extend(result.get("resources") or [])
            pages += 1
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return {"resources": resources, "pages": pages, "next_cursor": cursor}

    async def list_prompts_all(self, max_pages: int = 10, page_size: int = 100) -> Dict[str, Any]:
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        prompts: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        pages = 0
        while pages < max_pages:
            result = await self.prompt_list_page(cursor=cursor, limit=page_size)
            prompts.extend(result.get("prompts") or [])
            pages += 1
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return {"prompts": prompts, "pages": pages, "next_cursor": cursor}

    # -- 资源订阅 -----------------------------------------------------------
    async def subscribe_resource(self, uri: str) -> Dict[str, Any]:
        key = str(uri)
        result = await self.transport.request("resources/subscribe", {"uri": key}, timeout=self.timeout)
        self.subscriptions.add(key)
        return self._subscription_report(result)

    async def unsubscribe_resource(self, uri: str) -> Dict[str, Any]:
        key = str(uri)
        result = await self.transport.request("resources/unsubscribe", {"uri": key}, timeout=self.timeout)
        self.subscriptions.discard(key)
        return self._subscription_report(result)

    async def sync_resource_subscriptions(self, desired: Iterable[str],
                                          ignore_errors: bool = False) -> Dict[str, Any]:
        """声明式订阅对账：desired 与本地镜像的差量 → 实际 subscribe/unsubscribe。"""
        plan = plan_subscription_changes(desired, self.subscriptions)
        subscribed: List[str] = []
        unsubscribed: List[str] = []
        errors: List[Dict[str, str]] = []
        for uri in plan["to_unsubscribe"]:
            try:
                await self.unsubscribe_resource(uri)
                unsubscribed.append(uri)
            except BridgeError as error:
                errors.append({"uri": uri, "code": getattr(error, "code", "E_INTERNAL")})
                if not ignore_errors:
                    raise
        for uri in plan["to_subscribe"]:
            try:
                await self.subscribe_resource(uri)
                subscribed.append(uri)
            except BridgeError as error:
                errors.append({"uri": uri, "code": getattr(error, "code", "E_INTERNAL")})
                if not ignore_errors:
                    raise
        return {
            "to_subscribe": plan["to_subscribe"],
            "to_unsubscribe": plan["to_unsubscribe"],
            "unchanged": plan["unchanged"],
            "subscribed": subscribed,
            "unsubscribed": unsubscribed,
            "errors": errors,
        }

    def resource_subscriptions(self) -> List[str]:
        return sorted(self.subscriptions)

    def supports_resource_subscriptions(self) -> bool:
        return bool((self.capabilities.get("resources") or {}).get("subscribe"))

    def add_resource_updated_handler(self, handler: Any) -> Any:
        """注册 resources/updated 回调（handler(params)，可为 async）；返回可注销的 listener。"""
        if not callable(handler):
            raise BridgeError("E_ARG_TYPE", "资源更新回调必须可调用")
        add = getattr(self.transport, "add_notification_handler", None)
        if not callable(add):
            raise BridgeError("E_UNSUPPORTED_CAPABILITY", "当前传输不支持 server→client 通知回调")

        def _listener(message: Any) -> None:
            if not isinstance(message, dict) or message.get("method") != "notifications/resources/updated":
                return
            params = message.get("params")
            payload = dict(params) if isinstance(params, dict) else {}
            try:
                result = handler(payload)
                if inspect.isawaitable(result):
                    asyncio.ensure_future(_maybe_await(result))
            except Exception:  # noqa: BLE001 - 回调失败不影响读循环
                pass

        add(_listener)
        self._resource_handlers.append(_listener)
        return _listener

    def remove_resource_updated_handler(self, handler: Any) -> bool:
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

    # -- 工具调用 -----------------------------------------------------------
    async def call_tool(self, name: str, args: Optional[Dict[str, Any]] = None,
                        approval: bool = False, timeout: Optional[float] = None,
                        on_progress: Optional[Any] = None, validate: bool = True,
                        progress: Optional[bool] = None,
                        on_request: Optional[Any] = None,
                        cancel_scope: Optional[AsyncCancellationScope] = None,
                        retry: Optional[Union[bool, int]] = None) -> Any:
        """异步调用一个 MCP 工具，返回工具原始结果（本地校验 + 审批 + 超时 + 进度/取消）。"""
        if retry:
            attempts = RETRY_POLICY["max_attempts"] if retry is True else int(retry)
            return await self.call_tool_with_retry(
                name, args, max_attempts=attempts, approval=approval, timeout=timeout,
                on_progress=on_progress, validate=validate, progress=progress,
                on_request=on_request, cancel_scope=cancel_scope,
            )
        detailed = await self._invoke_tool(
            name, args, approval=approval, timeout=timeout, on_progress=on_progress,
            validate=validate, progress=progress, on_request=on_request,
            cancel_scope=cancel_scope,
        )
        return detailed["payload"]

    async def call_tool_detailed(self, name: str, args: Optional[Dict[str, Any]] = None,
                                 approval: bool = False, timeout: Optional[float] = None,
                                 on_progress: Optional[Any] = None, validate: bool = True,
                                 progress: Optional[bool] = None,
                                 on_request: Optional[Any] = None,
                                 cancel_scope: Optional[AsyncCancellationScope] = None) -> Dict[str, Any]:
        """同 call_tool，但返回 payload/meta/elapsed_ms/request_id/events + 恢复/审批元信息。"""
        return await self._invoke_tool(
            name, args, approval=approval, timeout=timeout, on_progress=on_progress,
            validate=validate, progress=progress, on_request=on_request,
            cancel_scope=cancel_scope,
        )

    async def _invoke_tool(self, name: str, args: Optional[Dict[str, Any]] = None,
                           approval: bool = False, timeout: Optional[float] = None,
                           on_progress: Optional[Any] = None, validate: bool = True,
                           progress: Optional[bool] = None,
                           on_request: Optional[Any] = None,
                           cancel_scope: Optional[AsyncCancellationScope] = None) -> Dict[str, Any]:
        spec = tool_spec(name)
        if spec is None:
            raise ToolCallError("E_ARG_UNEXPECTED", f"未知 MCP 工具：{name}", tool=str(name))
        if validate:
            validation = validate_tool_args(name, args)
            if not validation.get("ok"):
                first = (validation.get("errors") or [{}])[0]
                raise ToolCallError(first.get("code") or "E_ARG_UNEXPECTED",
                                    first.get("message") or "入参校验失败",
                                    tool=str(name), details=validation.get("errors"))
        bag = dict(args or {})
        if spec["approval_required"] and not approval:
            if spec["approval_always"] or not approval_disabled():
                raise ToolCallError(
                    "E_HUMAN_GATE",
                    f"{name} 属于 {spec['tier']} 级工具，需要人工确认：用 approval=True 重试。",
                    tool=name,
                    details={"tier": spec["tier"], "approval_required": True, "retry": "after-action"},
                )
        wait = float(timeout) if timeout else spec["timeout_ms"] / 1000.0
        started = time.monotonic()
        events: List[Dict[str, Any]] = []
        request_id: Dict[str, Any] = {"id": None}

        def _emit(event: Dict[str, Any]) -> None:
            events.append(dict(event))
            _emit_progress(on_progress, event)

        progress_token = _new_progress_token() if progress else None
        progress_handler: Optional[Any] = None
        transport = self.transport
        if progress_token is not None and on_progress is not None:
            add_handler = getattr(transport, "add_notification_handler", None)
            if callable(add_handler):
                def _on_progress_notification(message: Any) -> None:
                    if not isinstance(message, dict) or message.get("method") != "notifications/progress":
                        return
                    params = message.get("params") or {}
                    if params.get("progressToken") != progress_token:
                        return
                    _emit({
                        "phase": "progress", "tool": name, "tier": spec["tier"],
                        "progress": params.get("progress"), "total": params.get("total"),
                        "message": params.get("message"), "elapsed_ms": _elapsed_ms(started),
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

            async def _on_start(rid: int) -> None:
                request_id["id"] = rid
                if cancel_scope is not None:
                    cancel_scope.attach(rid, self.cancel_request)
                if on_request is not None:
                    await _maybe_await(on_request(rid))

            if on_request is not None or cancel_scope is not None:
                request_options["on_start"] = _on_start
            try:
                result = await transport.request("tools/call", params, **request_options)
            except BridgeError as error:
                phase = "cancelled" if error.code == "E_CANCELLED" else "error"
                _emit({"phase": phase, "tool": name, "tier": spec["tier"],
                       "elapsed_ms": _elapsed_ms(started), "code": error.code})
                raise
            result_meta = result.get("_meta") if isinstance(result, dict) else None
            try:
                payload = _payload_from_tool_result(name, result)
            except ToolCallError as error:
                _emit({"phase": "error", "tool": name, "tier": spec["tier"],
                       "elapsed_ms": _elapsed_ms(started), "code": error.code})
                raise
            elapsed = _elapsed_ms(started)
            _emit({"phase": "done", "tool": name, "tier": spec["tier"], "elapsed_ms": elapsed, "cursor": bag.get("cursor")})
            meta_dict = dict(result_meta) if isinstance(result_meta, dict) else {}
            return {
                "payload": payload,
                "meta": meta_dict,
                "elapsed_ms": elapsed,
                "request_id": request_id["id"],
                "events": events,
                "progress_summary": summarize_progress(events),
                "tool": name,
                "tier": spec["tier"],
                "recovery": meta_dict.get("browser-bridge/recovery"),
                "error": meta_dict.get("browser-bridge/error"),
                "approval_receipt": meta_dict.get("browser-bridge/approval-receipt"),
            }
        finally:
            if progress_handler is not None:
                remove_handler = getattr(transport, "remove_notification_handler", None)
                if callable(remove_handler):
                    remove_handler(progress_handler)
                progress_handler = None

    async def cancel_request(self, request_id: int, reason: str = "") -> bool:
        """取消在途请求（cancel_scope/on_request 拿到的 request_id）。"""
        transport = self.transport
        cancel = getattr(transport, "cancel", None)
        if not callable(cancel):
            return False
        return bool(await _maybe_await(cancel(request_id, reason)))

    async def call_tool_paged(self, name: str, args: Optional[Dict[str, Any]] = None,
                              max_pages: int = DEFAULT_PAGE_LIMIT, **options: Any) -> List[Any]:
        """对分页工具按续读标记自动翻页；返回每页 payload 列表。"""
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        markers = pagination_markers(name)
        current = dict(args or {})
        pages: List[Any] = []
        while len(pages) < max_pages:
            page = await self.call_tool(name, current, **options)
            pages.append(page)
            if not markers.get("partial"):
                break
            continuation = next_page_params(name, page)
            if not continuation:
                break
            current.update(continuation)
        return pages

    async def iter_tool_pages(self, name: str, args: Optional[Dict[str, Any]] = None,
                              max_pages: int = DEFAULT_PAGE_LIMIT,
                              **options: Any) -> AsyncIterator[Any]:
        """异步生成器版分页：每产出一页前先请求；用尽/不再续读时停止。"""
        if not isinstance(max_pages, int) or max_pages < 1:
            raise BridgeError("E_ARG_RANGE", f"max_pages 必须是正整数，实际 {max_pages!r}")
        markers = pagination_markers(name)
        current = dict(args or {})
        produced = 0
        while produced < max_pages:
            page = await self.call_tool(name, current, **options)
            produced += 1
            yield page
            if not markers.get("partial"):
                return
            continuation = next_page_params(name, page)
            if not continuation:
                return
            current.update(continuation)

    async def call_tool_with_retry(self, name: str, args: Optional[Dict[str, Any]] = None,
                                   max_attempts: Optional[int] = None,
                                   on_retry: Optional[Any] = None,
                                   sleep: Optional[Any] = None, **options: Any) -> Any:
        """按 mcp/error-map 的 retry_plan 做指数退避重试（只对可重试错误）。

        - on_retry(event) 在每次重试前回调 {tool, attempt, code, delay_ms, reason}；
        - sleep 可注入（单测用，避免真实等待）；默认 asyncio.sleep。
        """
        attempts = int(max_attempts) if max_attempts else int(RETRY_POLICY["max_attempts"])
        attempts = max(1, attempts)
        waiter = sleep or asyncio.sleep
        attempt = 1
        while True:
            try:
                return await self.call_tool(name, args, **options)
            except BridgeError as error:
                code = getattr(error, "code", "E_INTERNAL")
                plan = retry_plan(code, attempt=attempt, max_attempts=attempts)
                if code in NON_RETRYABLE_FOR_ASYNC or not plan.get("retryable") or attempt >= attempts:
                    raise
                attempt += 1
                delay_ms = float(plan.get("delay_ms") or 0)
                if on_retry is not None:
                    try:
                        await _maybe_await(on_retry({
                            "tool": name, "attempt": attempt - 1, "code": code,
                            "delay_ms": delay_ms, "reason": plan.get("reason"),
                        }))
                    except Exception:  # noqa: BLE001 - 回调失败不中断重试
                        pass
                if delay_ms > 0:
                    await waiter(delay_ms / 1000.0)

    async def call_tools(self, calls: Iterable[Any], max_concurrency: int = 4,
                         **options: Any) -> List[Dict[str, Any]]:
        """并发调用多个工具（有界并发，保持输入顺序；单点失败不影响其它调用）。

        calls 形如 ``[("browser_status", {}), {"name": "browser_observe", "args": {}}]``。
        返回 ``[{ok, name, result|error, code}]``（按输入顺序）。
        """
        normalized: List[Dict[str, Any]] = []
        for item in calls:
            if isinstance(item, dict):
                normalized.append({
                    "name": str(item.get("name")),
                    "args": item.get("args") or {},
                    "options": {key: value for key, value in item.items() if key not in ("name", "args")},
                })
            else:
                name = item[0]
                args = item[1] if len(item) > 1 else {}
                normalized.append({"name": str(name), "args": args or {}, "options": {}})
        if not normalized:
            return []
        semaphore = asyncio.Semaphore(max(1, min(int(max_concurrency), len(normalized))))

        async def _run(row: Dict[str, Any]) -> Dict[str, Any]:
            merged = dict(options)
            merged.update(row["options"])
            async with semaphore:
                try:
                    result = await self.call_tool(row["name"], row["args"], **merged)
                    return {"ok": True, "name": row["name"], "result": result}
                except (BridgeError, ToolCallError) as error:
                    return {"ok": False, "name": row["name"],
                            "code": getattr(error, "code", "E_INTERNAL"), "error": str(error)}

        return list(await asyncio.gather(*(_run(row) for row in normalized)))

    # -- 审计辅助 -----------------------------------------------------------
    def tool_coverage(self) -> Dict[str, Any]:
        """全部 MCP 工具覆盖审计（同步模块的同一份实现 + 异步矩阵字段）。"""
        coverage = tool_coverage()
        coverage["async_total"] = len(self._tools)
        coverage["async_missing"] = [name for name in self._tools.names() if name not in TOOL_CATALOG]
        return coverage

    def matrix_coverage(self) -> Dict[str, Any]:
        return self._tools.coverage()
