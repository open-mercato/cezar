#!/usr/bin/env python3
"""A fake `gh` for the detail screens and PR adoption.

`FAKE_GH_BRANCH` is the head branch pull request 7 reports. Every call is appended to
`$FAKE_GH_LOG` so a test can prove what ran.
"""

import json
import os
import pathlib
import sys

args = sys.argv[1:]
log = os.environ.get("FAKE_GH_LOG")
if log:
    with pathlib.Path(log).open("a", encoding="utf-8") as handle:
        handle.write(" ".join(args) + "\n")

branch = os.environ.get("FAKE_GH_BRANCH", "cez/aaaaaaaa")


def pr(number: int, state: str, head: str, base: str = "main") -> dict:
    return {
        "number": number,
        "url": f"https://github.com/acme/shop/pull/{number}",
        "state": state,
        "title": f"PR {number} title",
        "author": {"login": "ada"},
        "body": f"body of {number}",
        "labels": [{"name": "bug"}],
        "headRefName": head,
        "baseRefName": base,
        "headRepositoryOwner": {"login": "acme"},
        "isDraft": False,
    }


if args[:2] == ["repo", "view"]:
    print("acme/shop")
elif args[:2] == ["pr", "view"]:
    number = int(args[2])
    if number == 7:
        print(json.dumps(pr(7, "OPEN", branch)))
    elif number == 8:
        print(json.dumps(pr(8, "MERGED", branch)))
    elif number == 9:
        print(json.dumps(pr(9, "OPEN", "someone/else")))
    elif number == 10:
        print(json.dumps(pr(10, "OPEN", branch, base="release")))
    else:
        print("Could not resolve to a PullRequest", file=sys.stderr)
        sys.exit(1)
elif args[:2] == ["pr", "list"]:
    print(json.dumps([pr(7, "OPEN", branch)]) if "--head" in args else "[]")
elif args[:2] == ["issue", "view"]:
    if int(args[2]) == 3:
        print(json.dumps({**pr(3, "OPEN", ""), "url": "https://github.com/acme/shop/issues/3"}))
    else:
        print("Could not resolve to an Issue", file=sys.stderr)
        sys.exit(1)
elif args[:1] == ["api"] and args[1].endswith("/files"):
    print(
        json.dumps(
            [
                {
                    "filename": "src/a.py",
                    "status": "modified",
                    "additions": 1,
                    "deletions": 1,
                    "patch": "@@ -1 +1 @@\n-old\n+new",
                }
            ]
        )
    )
elif args[:1] == ["api"]:
    print("[]")
else:
    print("{}")
