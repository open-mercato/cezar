import json
import sys
from pathlib import Path

Path(sys.argv[0] + ".args").write_text("\n".join(sys.argv[1:]))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("type") != "prompt":
        continue
    delta = "pi " + msg["message"]
    sys.stdout.write(
        json.dumps(
            {
                "type": "message_update",
                "assistantMessageEvent": {"type": "text_delta", "delta": delta},
            }
        )
        + "\n"
    )
    sys.stdout.write(
        json.dumps({"type": "tool_execution_start", "toolCallId": "1", "toolName": "read"}) + "\n"
    )
    sys.stdout.write(
        json.dumps({"type": "tool_execution_end", "toolCallId": "1", "result": "ok"}) + "\n"
    )
    sys.stdout.write(json.dumps({"type": "agent_settled"}) + "\n")
    sys.stdout.flush()
    break
