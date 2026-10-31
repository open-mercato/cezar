from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

TASK = Route("GET /tasks/{run_id}")
TASK_LIVE = Route("GET /tasks/{run_id}/live")
TASK_CANCEL = Route("POST /tasks/{run_id}/cancel")
TASK_FINISH = Route("POST /tasks/{run_id}/finish")
TASK_DELETE = Route("POST /tasks/{run_id}/delete")
TASK_MESSAGE = Route("POST /tasks/{run_id}/message")
TASK_APPROVE = Route("POST /tasks/{run_id}/approve")
TASK_REJECT = Route("POST /tasks/{run_id}/reject")
TASK_DISPATCH = Route("POST /tasks/{run_id}/dispatch")
TASK_COMMIT = Route("POST /tasks/{run_id}/commit")
TASK_PUSH = Route("POST /tasks/{run_id}/push")
TASK_PR = Route("POST /tasks/{run_id}/pr")
TASK_PR_ADOPT = Route("POST /tasks/{run_id}/pr/adopt")
TASK_REVIEW = Route("POST /tasks/{run_id}/review")
TASK_NOTES = Route("POST /tasks/{run_id}/notes")
TASK_SHELL = Route("POST /tasks/{run_id}/shell")

PANES = ("session", "diff", "files", "commits", "graph", "notes", "terminal", "browser")


@dataclass(frozen=True, slots=True)
class TaskView:
    pane: str = "session"
    thread: str = "auto"

    @classmethod
    def from_query(cls, query: ParsedQuery) -> TaskView:
        pane = query.get("pane", "session")
        thread = query.get("thread", "auto")
        if thread not in ("auto", "flat", "virtual"):
            thread = "auto"
        return cls(pane if pane in PANES else "session", thread)

    def query(self) -> dict[str, str]:
        params = {"pane": self.pane}
        if self.thread != "auto":
            params["thread"] = self.thread
        return params
