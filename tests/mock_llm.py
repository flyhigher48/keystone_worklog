"""A tiny OpenAI-compatible chat server for tests: scripted replies, streaming and tool calls.

    server, url = start()      # url like http://127.0.0.1:54321/v1
    ...
    server.shutdown()

Behaviour:
- a request that offers a `get_time` tool gets a tool call back (used by "Test connection");
- a user message containing "search for X" gets a `search_notes` tool call, then a summary of the result;
- anything else gets "Hello from the mock model. You said: ...".
Requests are recorded in `server.log` (auth header, model, stream flag, tool names).
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = "sk-test-123456789"


def _reply(messages, tools):
    names = {t["function"]["name"] for t in tools or []}
    if "get_time" in names:
        return {"tool": ("get_time", {})}
    last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
    text = messages[last_user]["content"]
    results = [m["content"] for m in messages[last_user:] if m["role"] == "tool"]
    if "search for " in text.lower() and "search_notes" in names:
        if not results:
            return {"tool": ("search_notes", {"query": text.lower().split("search for ", 1)[1].strip(" .?")})}
        return {"text": "Found: " + results[-1].splitlines()[0]}
    return {"text": "Hello from the mock model. You said: " + text[:80]}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._json(200, {"data": [{"id": "mock-local"}, {"id": "mock-cloud"}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        auth = self.headers.get("Authorization")
        self.server.log.append({"auth": auth, "model": body.get("model"), "stream": body.get("stream"),
                                "tools": [t["function"]["name"] for t in body.get("tools", [])]})
        if auth not in (f"Bearer {API_KEY}", None):
            return self._json(401, {"error": {"message": "Invalid API key"}})
        r = _reply(body["messages"], body.get("tools"))
        call_id = f"call_{len(self.server.log)}"
        if not body.get("stream"):
            msg = {"role": "assistant", "content": r.get("text")}
            if "tool" in r:
                msg["tool_calls"] = [{"id": call_id, "type": "function", "function": {"name": r["tool"][0], "arguments": json.dumps(r["tool"][1])}}]
            return self._json(200, {"choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if "tool" in r else "stop"}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def event(delta, finish=None):
            self.wfile.write(f"data: {json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]})}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.005)
        if "tool" in r:
            args = json.dumps(r["tool"][1])
            event({"role": "assistant", "tool_calls": [{"index": 0, "id": call_id, "type": "function", "function": {"name": r["tool"][0], "arguments": ""}}]})
            event({"tool_calls": [{"index": 0, "function": {"arguments": args[: len(args) // 2]}}]})
            event({"tool_calls": [{"index": 0, "function": {"arguments": args[len(args) // 2:]}}]}, "tool_calls")
        else:
            words = r["text"].split(" ")
            for i in range(0, len(words), 3):
                event({"content": " ".join(words[i:i + 3]) + (" " if i + 3 < len(words) else "")})
            event({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")


def start():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.log = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"
