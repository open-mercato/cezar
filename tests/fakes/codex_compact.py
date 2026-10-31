import json
import sys


def emit(obj: object) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        emit({"id": msg["id"], "result": {"userAgent": "fake"}})
    elif method in ("thread/start", "thread/resume"):
        emit({"id": msg["id"], "result": {"thread": {"id": "th_compact"}}})
    elif method == "turn/start":
        text = msg["params"]["input"][0]["text"]
        emit({"id": msg["id"], "result": {"turn": {"id": "turn_1"}}})
        if "automatically compacted" in text:
            emit(
                {
                    "method": "item/completed",
                    "params": {
                        "threadId": "th_compact",
                        "item": {"id": "m1", "type": "agentMessage", "text": "CEZ:DONE"},
                    },
                }
            )
        else:
            emit(
                {
                    "method": "item/completed",
                    "params": {
                        "threadId": "th_compact",
                        "item": {"id": "c1", "type": "contextCompaction"},
                    },
                }
            )
        emit(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "th_compact",
                    "turn": {"id": "turn_1", "status": "completed"},
                },
            }
        )
        break
