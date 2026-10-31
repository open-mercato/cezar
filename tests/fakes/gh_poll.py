#!/usr/bin/env python3
"""A fake `gh` for the automation pollers.

`FAKE_GH_DIR` holds the canned answers: `search.json` for `/search/issues`,
`timeline-<n>.json` for an issue timeline, `pull-<n>.json` for a pull request. Every call is
appended to `calls.log` so a test can prove `gh` was (or was not) reached.
"""

import json
import os
import pathlib
import re
import sys

root = pathlib.Path(os.environ["FAKE_GH_DIR"])
args = sys.argv[1:]
with (root / "calls.log").open("a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\n")


def answer(name: str, default: str) -> None:
    path = root / name
    print(path.read_text(encoding="utf-8") if path.exists() else default)


timeline = next((re.search(r"/issues/(\d+)/timeline$", a) for a in args if "/timeline" in a), None)
pull = next((re.search(r"/pulls/(\d+)$", a) for a in args if "/pulls/" in a), None)
if args[:2] == ["repo", "view"]:
    print("acme/shop")
elif "/search/issues" in args:
    if "page=2" in args:
        print('{"items": []}')
    else:
        answer("search.json", '{"items": []}')
elif timeline:
    answer(f"timeline-{timeline.group(1)}.json", "[]")
elif pull:
    path = root / f"pull-{pull.group(1)}.json"
    if not path.exists():
        sys.exit(1)
    print(path.read_text(encoding="utf-8"))
else:
    print(json.dumps({}))
