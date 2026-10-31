import json
import sys

resumes = 0


def emit(obj: object) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        emit({"id": msg["id"], "result": {"userAgent": "fake"}})
    elif method == "thread/resume":
        resumes += 1
        if resumes == 1:
            emit({"id": msg["id"], "error": {"message": "thread already has an active writer"}})
        else:
            emit({"id": msg["id"], "result": {"thread": {"id": "th_saved"}}})
    elif method == "thread/fork":
        emit({"id": msg["id"], "result": {"thread": {"id": "th_fork"}}})
    elif method == "turn/start":
        text = msg["params"]["input"][0]["text"]
        emit({"id": msg["id"], "result": {"turn": {"id": "turn_1"}}})
        emit(
            {
                "method": "item/agentMessage/delta",
                "params": {"threadId": "th_saved", "delta": "codex " + text},
            }
        )
        emit(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "th_saved",
                    "turn": {
                        "status": "completed",
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                    },
                },
            }
        )
        break
