"""BrowserBridge Python SDK

与 Node SDK 对齐的薄封装：直接调用本地 daemon 的 HTTP /rpc，保留协议错误码与
session 语义。API 形状尽量接近 Playwright 的 ``browser.new_page()`` / ``page.*``。

用法::

    from browser_bridge import connect

    bb = connect()
    page = bb.new_page()
    page.goto("https://example.com")
    page.fill("#q", "browser bridge")
    page.press("Enter")
    print(page.observe()["observation"])
    page.close()

零第三方依赖：只用 Python 标准库（urllib / json / subprocess）。
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Union

DEFAULT_TIMEOUT = 60.0
START_TIMEOUT = 12.0
SDK_DIR = Path(__file__).resolve().parent
REPO_ROOT = SDK_DIR.parent.parent


class BridgeError(Exception):
    """daemon 业务错误；code 为协议错误码，data 保留结构化细节。"""

    def __init__(self, code: str, message: str, data: Any = None, method: Optional[str] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.data = data
        self.method = method
        self.effect_state = None
        if isinstance(data, dict):
            self.effect_state = data.get("effect_state") or data.get("effectState")


def default_home() -> Path:
    configured = os.environ.get("BB_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".browser-bridge"


def daemon_info_path(home: Optional[Union[str, Path]] = None) -> Path:
    return Path(home).expanduser() / "daemon.json" if home else default_home() / "daemon.json"


def read_daemon_info(home: Optional[Union[str, Path]] = None) -> Optional[Dict[str, Any]]:
    try:
        info = json.loads(daemon_info_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(info, dict) and isinstance(info.get("port"), int) and isinstance(info.get("token"), str):
        return info
    return None


def _request_json(info: Dict[str, Any], path: str, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{info['port']}{path}",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-bridge-token": str(info.get("token", "")),
        },
    )
    if info.get("tls") is True:
        request.full_url = f"https://127.0.0.1:{info['port']}{path}"
    context = ssl._create_unverified_context() if info.get("tls") is True else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise BridgeError("E_DAEMON", f"daemon HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise BridgeError("E_DAEMON", f"连接 daemon 失败：{error}") from error


def _health_ok(info: Dict[str, Any]) -> bool:
    url = f"{'https' if info.get('tls') is True else 'http'}://127.0.0.1:{info['port']}/health"
    context = ssl._create_unverified_context() if info.get("tls") is True else None
    try:
        with urllib.request.urlopen(url, timeout=0.8, context=context) as response:
            return response.status == 200
    except Exception:
        return False


def start_daemon(home: Optional[Union[str, Path]] = None, timeout: float = START_TIMEOUT) -> Dict[str, Any]:
    """没有 daemon 时用当前 Python 环境能找到的 node 拉起 workspace daemon。"""
    home_path = Path(home).expanduser() if home else default_home()
    server = REPO_ROOT / "daemon" / "server.mjs"
    if not server.exists():
        raise BridgeError("E_DAEMON", f"找不到 daemon/server.mjs：{server}")
    node = os.environ.get("BB_NODE") or "node"
    env = dict(os.environ)
    env["BB_HOME"] = str(home_path)
    try:
        subprocess.Popen(
            [node, str(server), "--foreground"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        raise BridgeError("E_DAEMON", f"拉起 daemon 失败（需要 node 在 PATH 或 BB_NODE）：{error}") from error
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.15)
        info = read_daemon_info(home_path)
        if info and _health_ok(info):
            return info
    raise BridgeError("E_DAEMON", f"daemon 在 {timeout:.0f}s 内未就绪；先运行 bridge status 查看日志")


def target_params(target: Union[str, Dict[str, Any]]) -> Dict[str, str]:
    if isinstance(target, dict):
        if target.get("ref"):
            return {"ref": str(target["ref"])}
        if target.get("selector"):
            return {"selector": str(target["selector"])}
        raise BridgeError("E_BAD_ARG", "target 需要 ref 或 selector")
    text = str(target or "")
    if not text:
        raise BridgeError("E_BAD_ARG", "缺少 target（@ref 或 CSS selector）")
    return {"ref": text} if text.startswith("@") else {"selector": text}


class Page:
    """一个浏览器会话（≈ Playwright 的 Page）。所有方法自动带 session。"""

    def __init__(self, bridge: "BrowserBridge", info: Dict[str, Any]):
        self.bridge = bridge
        self.id = info["sessionId"]
        self.tab_id = info.get("tabId")
        self.window_id = info.get("windowId")
        self.instance_id = info.get("instanceId")

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        merged = {"session": self.id}
        merged.update(params or {})
        return self.bridge.rpc(method, merged, timeout=timeout)

    def goto(self, url: str, **options: Any) -> Any:
        return self.call("navigate", {"url": str(url), **options})

    def reload(self, **options: Any) -> Any:
        return self.call("reload", options)

    def back(self, **options: Any) -> Any:
        return self.call("navigate-back", options)

    def forward(self, **options: Any) -> Any:
        return self.call("navigate-forward", options)

    def click(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("click", {**target_params(target), **options})

    def hover(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("hover", {**target_params(target), **options})

    def fill(self, target: Union[str, Dict[str, Any]], value: str, **options: Any) -> Any:
        return self.call("fill", {**target_params(target), "value": str(value), **options})

    def press(self, key: str, target: Optional[Union[str, Dict[str, Any]]] = None, **options: Any) -> Any:
        params: Dict[str, Any] = {"key": str(key), **options}
        if target is not None:
            params.update(target_params(target))
        return self.call("press", params)

    def select(self, target: Union[str, Dict[str, Any]], value: str, **options: Any) -> Any:
        return self.call("select", {**target_params(target), "value": str(value), **options})

    def evaluate(self, expression: str) -> Any:
        return self.call("evaluate", {"expression": str(expression)})

    def observe(self, **options: Any) -> Any:
        return self.call("observe", options)

    def snapshot(self) -> Any:
        return self.call("snapshot", {})

    def wait_for_element(self, target: Union[str, Dict[str, Any]], **options: Any) -> Any:
        return self.call("wait-for-element", {**target_params(target), **options})

    def wait_for_navigation(self, **options: Any) -> Any:
        return self.call("wait-for-navigation", options)

    def screenshot(self, path: Optional[Union[str, Path]] = None, **options: Any) -> Any:
        result = self.call("screenshot", options)
        if path and isinstance(result, dict) and isinstance(result.get("dataUrl"), str):
            data = result["dataUrl"].split(",", 1)[-1]
            output = Path(path).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(base64.b64decode(data))
        return result

    def pause(self, reason: str = "python-sdk") -> Any:
        return self.call("session.pause", {"paused": True, "reason": reason})

    def resume(self) -> Any:
        return self.call("session.pause", {"paused": False})

    def close(self, keep: bool = False) -> Any:
        return self.bridge.rpc("session.stop", {"session": self.id, "keep": bool(keep)})


class BrowserBridge:
    """daemon 连接（≈ Playwright 的 Browser）。"""

    def __init__(self, info: Dict[str, Any], home: Optional[Union[str, Path]] = None, timeout: float = DEFAULT_TIMEOUT):
        self.info = {"port": int(info["port"]), "token": str(info["token"]), "tls": info.get("tls") is True}
        self.home = Path(home).expanduser() if home else default_home()
        self.timeout = float(timeout)

    @classmethod
    def connect(
        cls,
        home: Optional[Union[str, Path]] = None,
        timeout: float = DEFAULT_TIMEOUT,
        auto_start: bool = True,
        start_timeout: float = START_TIMEOUT,
    ) -> "BrowserBridge":
        home_path = Path(home).expanduser() if home else default_home()
        info = read_daemon_info(home_path)
        if not info:
            if not auto_start:
                raise BridgeError("E_DAEMON", f"daemon 未运行，且 auto_start=False：{daemon_info_path(home_path)}")
            info = start_daemon(home_path, timeout=start_timeout)
        return cls(info, home=home_path, timeout=timeout)

    def rpc(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Any:
        payload = {"method": method, "params": params or {}, "timeoutMs": int((timeout or self.timeout) * 1000)}
        body = _request_json(self.info, "/rpc", payload, (timeout or self.timeout) + 1.0)
        if body.get("ok") is not True:
            error = body.get("error") or {}
            raise BridgeError(
                str(error.get("code") or "E_INTERNAL"),
                str(error.get("message") or "rpc failed"),
                data=error.get("data"),
                method=method,
            )
        return body.get("result")

    def status(self) -> Any:
        return self.rpc("status")

    def sessions(self) -> List[Dict[str, Any]]:
        return list((self.rpc("session.list") or {}).get("sessions") or [])

    def browsers(self) -> List[Dict[str, Any]]:
        return list((self.rpc("browsers") or {}).get("browsers") or [])

    def new_page(
        self,
        url: Optional[str] = None,
        browser: Optional[str] = None,
        tab: Optional[int] = None,
        no_focus: bool = False,
        incognito: bool = False,
    ) -> Page:
        params: Dict[str, Any] = {}
        if browser:
            params["browser"] = str(browser)
        if tab is not None:
            params["tab"] = int(tab)
        if no_focus:
            params["noFocus"] = True
        if incognito:
            params["incognito"] = True
        info = self.rpc("session.start", params)
        page = Page(self, info)
        if url:
            page.goto(url)
        return page

    def page(self, session_id: str) -> Page:
        for item in self.sessions():
            if item.get("sessionId") == str(session_id):
                return Page(self, item)
        raise BridgeError("E_NO_SESSION", f'session "{session_id}" 不存在')

    def pages(self) -> List[Page]:
        return [Page(self, item) for item in self.sessions()]

    def stop_daemon(self) -> None:
        try:
            self.rpc("daemon.stop", {}, timeout=3.0)
        except BridgeError:
            pass


def connect(**options: Any) -> BrowserBridge:
    return BrowserBridge.connect(**options)


def write_data_url(path: Union[str, Path], data_url: str) -> Path:
    marker = str(data_url or "").find(",")
    if marker < 0:
        raise BridgeError("E_INTERNAL", "截图结果不是 dataUrl")
    output = Path(path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(str(data_url)[marker + 1 :]))
    return output
