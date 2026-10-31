import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[sys.argv.index("--port") + 1])


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        with open(sys.argv[0] + ".log", "a", encoding="utf-8") as log:
            log.write(self.path + "\n")
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/session":
            payload = {"id": "ses_1"}
        else:
            text = body["parts"][0]["text"]
            payload = {"parts": [{"type": "text", "text": "oc " + text}]}
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args: object) -> None:
        return


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
