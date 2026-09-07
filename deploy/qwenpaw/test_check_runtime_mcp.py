import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("check_runtime_mcp.py")
SPEC = importlib.util.spec_from_file_location("check_runtime_mcp", MODULE_PATH)
check_runtime_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_runtime_mcp)


class RuntimeMcpPreflightTest(unittest.TestCase):
    def test_reads_only_private_regular_token(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("test-token\n", encoding="utf-8")
            token.chmod(0o600)
            self.assertEqual(check_runtime_mcp.read_token(token), "test-token")
            token.chmod(0o644)
            if os.name != "nt":
                with self.assertRaises(ValueError):
                    check_runtime_mcp.read_token(token)

    def test_main_requires_runtime_lookup_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "token"
            token.write_text("test-token\n", encoding="utf-8")
            token.chmod(0o600)
            replies = [
                {"jsonrpc": "2.0", "result": {"protocolVersion": "2025-03-26"}},
                {"jsonrpc": "2.0", "result": {"tools": [{"name": "qdm_auth_lookup_blob"}]}},
            ]
            with patch.object(check_runtime_mcp, "rpc", side_effect=replies), patch("sys.argv", ["check_runtime_mcp.py", "--token-file", str(token)]):
                self.assertEqual(check_runtime_mcp.main(), 0)
            replies[-1] = {"jsonrpc": "2.0", "result": {"tools": [{"name": "qdm_auth_get"}]}}
            with patch.object(check_runtime_mcp, "rpc", side_effect=replies), patch("sys.argv", ["check_runtime_mcp.py", "--token-file", str(token)]), patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(check_runtime_mcp.main(), 1)

    def test_parses_sse_json_rpc_response(self):
        payload = {"jsonrpc": "2.0", "result": {"tools": []}}
        raw = f"event: message\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
        self.assertEqual(check_runtime_mcp.parse_response(raw, "text/event-stream"), payload)


if __name__ == "__main__":
    unittest.main()
