import json
import sys
from pathlib import Path

Path(sys.argv[0] + ".args").write_text("\n".join(sys.argv[1:]))
msg = json.loads(sys.stdin.readline())
text = msg["message"]["content"][0]["text"]


def emit(obj: object) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


emit(
    {
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "did " + text},
                {"type": "tool_use", "id": "t1", "name": "Write", "input": {}},
            ]
        },
    }
)
emit(
    {
        "type": "user",
        "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "wrote"}]},
    }
)
emit(
    {
        "type": "result",
        "result": "did " + text,
        "usage": {"input_tokens": 2, "output_tokens": 3},
    }
)
