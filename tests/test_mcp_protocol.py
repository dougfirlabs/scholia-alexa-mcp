import base64
from hashlib import sha256
import unittest

from pathlib import Path
import sys


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from mcp_protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    authorize_header,
    handle_rpc_message,
    lint_snippet,
    origin_allowed,
)


class McpProtocolTests(unittest.TestCase):
    def test_initialize_advertises_tools_and_resources(self):
        response = handle_rpc_message(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "0"},
                },
            }
        )

        self.assertEqual(response["result"]["protocolVersion"], PROTOCOL_VERSION)
        self.assertIn("tools", response["result"]["capabilities"])
        self.assertIn("resources", response["result"]["capabilities"])

    def test_notification_returns_no_response(self):
        response = handle_rpc_message({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertIsNone(response)

    def test_tools_list_contains_catalog(self):
        response = handle_rpc_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertIn("scholialang.catalog", names)

    def test_get_example_returns_xml(self):
        response = handle_rpc_message(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "scholialang.get_example",
                    "arguments": {"id": "hypothesis-evidence-finding", "format": "xml"},
                },
            }
        )

        text = response["result"]["content"][0]["text"]
        self.assertIn("<Hypothesis", text)
        self.assertFalse(response["result"]["isError"])

    def test_missing_resource_returns_mcp_resource_error(self):
        response = handle_rpc_message(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "resources/read",
                "params": {"uri": "scholialang://missing"},
            }
        )

        self.assertEqual(response["error"]["code"], -32002)

    def test_lint_detects_unclosed_tag(self):
        result = lint_snippet('<Step id="Step_01" name="Broken"><Finding>')
        self.assertFalse(result["ok"])
        self.assertIn("unclosed tag: Finding", result["errors"])

    def test_auth_denies_when_not_configured(self):
        ok, reason = authorize_header("Bearer any")
        self.assertFalse(ok)
        self.assertEqual(reason, "unauthorized")

    def test_auth_accepts_bearer_token(self):
        ok, reason = authorize_header("Bearer secret", token_hashes=sha256(b"secret").hexdigest())
        self.assertTrue(ok)
        self.assertEqual(reason, "judge:" + sha256(b"secret").hexdigest())

    def test_auth_rejects_basic_credentials(self):
        credentials = base64.b64encode(b"scholia:secret").decode("ascii")
        ok, reason = authorize_header(f"Basic {credentials}", token_hashes=sha256(b"secret").hexdigest())
        self.assertFalse(ok)
        self.assertEqual(reason, "unauthorized")

    def test_origin_allows_same_origin_and_configured_origin(self):
        self.assertTrue(origin_allowed("https://mcp.example.com", "https://mcp.example.com/mcp"))
        self.assertTrue(
            origin_allowed(
                "https://client.example.com",
                "https://mcp.example.com/mcp",
                "https://client.example.com",
            )
        )
        self.assertFalse(origin_allowed("https://bad.example.com", "https://mcp.example.com/mcp"))


if __name__ == "__main__":
    unittest.main()
