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
    elif method == "thread/start":
        params = msg["params"]
        sandbox = params.get("sandbox")
        policy = params.get("approvalPolicy")
        if sandbox != "danger-full-access" or policy != "never":
            emit({"id": msg["id"], "error": {"message": "bad sandbox"}})
            break
        emit({"id": msg["id"], "result": {"thread": {"id": "th_parent"}}})
    elif method == "turn/start":
        text = msg["params"]["input"][0]["text"]
        emit({"id": msg["id"], "result": {"turn": {"id": "turn_1"}}})
        emit(
            {
                "method": "turn/completed",
                "params": {
                    "threadId": "th_child",
                    "turn": {"status": "completed"},
                },
            }
        )
        emit(
            {
                "method": "item/agentMessage/delta",
                "params": {"threadId": "th_parent", "delta": "codex " + text},
            }
        )
        usage = {"input_tokens": 1, "output_tokens": 1}
        turn = {"id": "turn_1", "status": "completed", "usage": usage}
        emit(
            {
                "method": "turn/completed",
                "params": {"threadId": "th_parent", "turn": turn},
            }
        )
        break
