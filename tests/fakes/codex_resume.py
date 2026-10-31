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
    elif method == "thread/resume":
        if msg["params"].get("threadId") != "th_saved":
            emit({"id": msg["id"], "error": {"message": "wrong thread"}})
            break
        emit({"id": msg["id"], "result": {"thread": {"id": "th_saved"}}})
    elif method == "turn/start":
        text = msg["params"]["input"][0]["text"]
        emit({"id": msg["id"], "result": {"turn": {"id": "turn_1"}}})
        delta = {"threadId": "th_saved", "delta": "codex " + text}
        emit({"method": "item/agentMessage/delta", "params": delta})
        usage = {"input_tokens": 1, "output_tokens": 1}
        turn = {"id": "turn_1", "status": "completed", "usage": usage}
        done = {"threadId": "th_saved", "turn": turn}
        emit({"method": "turn/completed", "params": done})
        break
