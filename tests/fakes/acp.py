import json
import sys


def emit(obj: object) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        emit(
            {
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"protocolVersion": 1},
            }
        )
    elif method == "session/new":
        emit(
            {
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"sessionId": "s1"},
            }
        )
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        emit(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "junie " + text},
                    }
                },
            }
        )
        emit(
            {
                "jsonrpc": "2.0",
                "id": msg["id"],
                "result": {"stopReason": "end_turn"},
            }
        )
        break
