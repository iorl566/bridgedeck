import base64
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from browser_bridge import BridgeError, BrowserBridge, connect, read_daemon_info, target_params, write_data_url  # noqa: E402


class MockDaemon(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *_args):
        return

    def _send(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send({"ok": True})
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        message = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        MockDaemon.calls.append({"method": message.get("method"), "params": message.get("params"), "token": self.headers.get("x-bridge-token")})
        method = message.get("method")
        params = message.get("params") or {}
        if method == "session.start":
            return self._send({"ok": True, "result": {"sessionId": "s1", "tabId": 11, "windowId": 12, "instanceId": "i1"}})
        if method == "session.list":
            return self._send({"ok": True, "result": {"sessions": [{"sessionId": "s1", "tabId": 11, "windowId": 12}]}})
        if method == "navigate":
            return self._send({"ok": True, "result": {"url": params.get("url"), "title": "fixture"}})
        if method in ("click", "fill"):
            if params.get("fail") is True:
                return self._send({"ok": False, "error": {"code": "E_SESSION_PAUSED", "message": "会话已暂停"}})
            return self._send({"ok": True, "result": {"ok": True}})
        if method == "evaluate":
            return self._send({"ok": True, "result": {"value": 42}})
        if method == "screenshot":
            data = base64.b64encode(b"png-bytes").decode("ascii")
            return self._send({"ok": True, "result": {"dataUrl": "data:image/png;base64," + data, "width": 3, "height": 4}})
        if method == "session.stop":
            return self._send({"ok": True, "result": {"ok": True}})
        return self._send({"ok": True, "result": {"ok": True, "method": method}})


class SdkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockDaemon)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        MockDaemon.calls = []
        self.home = tempfile.mkdtemp(prefix="bb-py-sdk-")
        info = {"pid": 1, "port": self.server.server_address[1], "token": "tok", "version": "test"}
        Path(self.home, "daemon.json").write_text(json.dumps(info), encoding="utf-8")

    def test_connect_reads_daemon_json_and_token(self):
        info = read_daemon_info(self.home)
        self.assertEqual(info["token"], "tok")
        bridge = connect(home=self.home)
        bridge.status()
        self.assertEqual(MockDaemon.calls[0]["token"], "tok")
        self.assertEqual(MockDaemon.calls[0]["method"], "status")

    def test_new_page_goto_and_target_mapping(self):
        bridge = BrowserBridge.connect(home=self.home)
        page = bridge.new_page(url="http://example.test/")
        self.assertEqual(page.id, "s1")
        self.assertEqual(page.tab_id, 11)
        self.assertEqual(MockDaemon.calls[0]["method"], "session.start")
        self.assertEqual(MockDaemon.calls[1]["method"], "navigate")
        self.assertEqual(MockDaemon.calls[1]["params"]["session"], "s1")
        self.assertEqual(MockDaemon.calls[1]["params"]["url"], "http://example.test/")

        page.click("@e3", trusted=True)
        self.assertEqual(MockDaemon.calls[2]["params"]["ref"], "@e3")
        self.assertTrue(MockDaemon.calls[2]["params"]["trusted"])

        page.fill("#name", "bridge", noClear=True)
        self.assertEqual(MockDaemon.calls[3]["params"]["selector"], "#name")
        self.assertEqual(MockDaemon.calls[3]["params"]["value"], "bridge")
        self.assertTrue(MockDaemon.calls[3]["params"]["noClear"])

        page.press("Enter", target="#name")
        self.assertEqual(MockDaemon.calls[4]["params"]["key"], "Enter")
        self.assertEqual(MockDaemon.calls[4]["params"]["selector"], "#name")

    def test_error_mapping_keeps_code_and_method(self):
        bridge = BrowserBridge.connect(home=self.home)
        page = bridge.new_page()
        with self.assertRaises(BridgeError) as caught:
            page.click("#covered", fail=True)
        self.assertEqual(caught.exception.code, "E_SESSION_PAUSED")
        self.assertEqual(caught.exception.method, "click")

    def test_screenshot_writes_file(self):
        bridge = BrowserBridge.connect(home=self.home)
        page = bridge.new_page()
        output = Path(self.home, "shot.png")
        page.screenshot(path=output, fullPage=True)
        self.assertEqual(output.read_bytes(), b"png-bytes")
        self.assertTrue(MockDaemon.calls[-1]["params"]["fullPage"])

    def test_pages_and_page_lookup(self):
        bridge = BrowserBridge.connect(home=self.home)
        pages = bridge.pages()
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0].id, "s1")
        page = bridge.page("s1")
        self.assertEqual(page.tab_id, 11)
        with self.assertRaises(BridgeError) as caught:
            bridge.page("nope")
        self.assertEqual(caught.exception.code, "E_NO_SESSION")

    def test_missing_daemon_with_auto_start_false(self):
        empty = tempfile.mkdtemp(prefix="bb-py-sdk-empty-")
        with self.assertRaises(BridgeError) as caught:
            connect(home=empty, auto_start=False)
        self.assertEqual(caught.exception.code, "E_DAEMON")

    def test_target_and_write_data_url_helpers(self):
        self.assertEqual(target_params("@e1"), {"ref": "@e1"})
        self.assertEqual(target_params("#x"), {"selector": "#x"})
        self.assertEqual(target_params({"selector": "a"}), {"selector": "a"})
        with self.assertRaises(BridgeError):
            target_params("")
        output = Path(self.home, "h.png")
        write_data_url(output, "data:image/png;base64," + base64.b64encode(b"x").decode("ascii"))
        self.assertEqual(output.read_bytes(), b"x")


if __name__ == "__main__":
    unittest.main()
