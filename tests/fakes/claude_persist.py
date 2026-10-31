import json
import sys


def emit(obj: object) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


while True:
    line = sys.stdin.readline()
    if not line:
        break
    msg = json.loads(line)
    text = msg["message"]["content"][0]["text"]
    emit(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "did " + text}]},
        }
    )
    emit(
        {
            "type": "result",
            "result": "did " + text,
            "usage": {"input_tokens": 1, "output_tokens": 1},
        }
    )
