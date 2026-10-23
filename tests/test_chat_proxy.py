"""The OpenAI-compatible proxy, against a local mock model server."""
import json
import unittest

import mock_llm
from helpers import Env


class ChatProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.url = mock_llm.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.env = Env()
        self.c = self.env.client
        r = self.c.put("/api/assistant/settings", json={"profiles": [
            {"name": "Local", "baseUrl": self.url, "model": "mock-local", "trackerAccess": True, "stream": True},
            {"name": "Cloud", "baseUrl": self.url, "apiKey": mock_llm.API_KEY, "model": "mock-cloud", "stream": False}]})
        self.local, self.cloud = [p["id"] for p in r.get_json()["profiles"]]
        self.server.log.clear()

    def tearDown(self):
        self.env.close()

    def test_models_and_test_connection(self):
        self.assertEqual(self.c.post("/api/assistant/models", json={"profileId": self.local}).get_json()["models"], ["mock-cloud", "mock-local"])
        self.assertTrue(self.c.post("/api/assistant/test", json={"profileId": self.local}).get_json()["toolCalls"])

    def test_key_is_sent_only_to_its_server_and_wrong_keys_are_reported(self):
        self.c.post("/api/assistant/test", json={"profileId": self.cloud})
        self.assertEqual(self.server.log[-1]["auth"], f"Bearer {mock_llm.API_KEY}")
        r = self.c.post("/api/assistant/test", json={"profile": {"id": self.cloud, "baseUrl": self.url, "apiKey": "sk-wrong-0000000", "model": "x"}})
        self.assertEqual(r.status_code, 502)
        self.assertIn("Invalid API key", r.get_json()["error"])

    def test_bad_and_unreachable_urls(self):
        r = self.c.post("/api/assistant/test", json={"profile": {"baseUrl": "ftp://x", "model": "x"}})
        self.assertIn("must start with http", r.get_json()["error"])
        r = self.c.post("/api/assistant/test", json={"profile": {"baseUrl": "http://127.0.0.1:9/v1", "model": "x"}})
        self.assertIn("Can't reach", r.get_json()["error"])

    def test_non_streaming_tool_call(self):
        tools = [{"type": "function", "function": {"name": "search_notes", "parameters": {"type": "object", "properties": {}}}}]
        r = self.c.post("/api/assistant/chat", json={"profileId": self.cloud, "messages": [{"role": "user", "content": "search for drainage"}], "tools": tools})
        call = r.get_json()["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(call["function"]["name"], "search_notes")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"query": "drainage"})
        self.assertEqual(self.server.log[-1]["model"], "mock-cloud")

    def test_streaming_is_relayed(self):
        r = self.c.post("/api/assistant/chat", json={"profileId": self.local, "messages": [{"role": "user", "content": "hi there"}]})
        self.assertEqual(r.mimetype, "text/event-stream")
        text = "".join(json.loads(line[5:])["choices"][0]["delta"].get("content", "")
                       for line in r.get_data(as_text=True).splitlines() if line.startswith("data: {"))
        self.assertEqual(text, "Hello from the mock model. You said: hi there")


if __name__ == "__main__":
    unittest.main()
