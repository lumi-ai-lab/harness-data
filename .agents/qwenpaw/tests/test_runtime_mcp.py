from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "qdm_harness_qwenpaw_runtime_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package

from qdm_harness_qwenpaw_runtime_test.qdm_channel_auth import ChannelAuthorizationError
from qdm_harness_qwenpaw_runtime_test.qdm_identity import Requester
from qdm_harness_qwenpaw_runtime_test.qdm_runtime_mcp import RuntimeMcpAuthProvider


class _McpHandler(BaseHTTPRequestHandler):
    mode = "ok"

    def do_POST(self) -> None:  # noqa: N802
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if request["method"] == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {}}
        elif self.mode == "mismatch":
            result = {"structuredContent": {"ok": True, "channel": "wecom", "user_id": "other", "blob": "qdm1enc.demo"}}
        else:
            payload = {"ok": True, "channel": "wecom", "user_id": "alice", "blob": "qdm1enc.demo"}
            result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode())

    def log_message(self, *_args: object) -> None:
        return


class RuntimeMcpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = HTTPServer(("127.0.0.1", 0), _McpHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.temp = tempfile.TemporaryDirectory()
        self.token = Path(self.temp.name) / "token"
        self.token.write_text("token", encoding="utf-8")
        self.token.chmod(0o600)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def provider(self) -> RuntimeMcpAuthProvider:
        return RuntimeMcpAuthProvider(f"http://127.0.0.1:{self.server.server_port}/mcp", self.token)

    def requester(self) -> Requester:
        return Requester(1, "resolved", "wecom", "alice", "single")

    def test_text_fallback_returns_complete_blob(self) -> None:
        self.assertEqual(self.provider().blob_for(self.requester()), "qdm1enc.demo")

    def test_identity_mismatch_fails_closed(self) -> None:
        _McpHandler.mode = "mismatch"
        try:
            with self.assertRaises(ChannelAuthorizationError):
                self.provider().blob_for(self.requester())
        finally:
            _McpHandler.mode = "ok"

    def test_unresolved_requester_fails_before_network(self) -> None:
        with self.assertRaises(ChannelAuthorizationError):
            self.provider().blob_for(Requester(1, "unavailable", "wecom", "", "single"))


if __name__ == "__main__":
    unittest.main()
