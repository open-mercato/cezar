import re

from stario import Route

REPO_COMMIT = Route("GET /git/commits/{sha}")
TASK_COMMIT_DETAIL = Route("GET /tasks/{run_id}/commits/{sha}")

_SHA = re.compile(r"^[0-9a-fA-F]{4,40}$")


def valid_sha(value: str) -> bool:
    return _SHA.fullmatch(value) is not None
