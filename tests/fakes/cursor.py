import json
import sys
from pathlib import Path

Path(sys.argv[0] + ".args").write_text("\n".join(sys.argv[1:]))
prompt = sys.argv[-1]
text = "cursor " + prompt
sys.stdout.write(
    json.dumps(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": text}]},
        }
    )
    + "\n"
)
sys.stdout.write(json.dumps({"type": "result", "result": text}) + "\n")
sys.stdout.flush()
