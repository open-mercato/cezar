from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

from app.engine.model import STATUSES

TASKS = Route("GET /tasks")
TASKS_LIVE = Route("GET /tasks/live")
TASKS_NEW = Route("GET /tasks/new")
TASKS_CREATE = Route("POST /tasks")
TASKS_ARCHIVE = Route("POST /tasks/archive-finished")
TASKS_READ = Route("POST /tasks/read-all")
HOME = Route("GET /")


@dataclass(frozen=True, slots=True)
class TasksView:
    project: str = ""
    status: str = "all"

    @classmethod
    def from_query(cls, query: ParsedQuery) -> TasksView:
        status = query.get("status", "all")
        project = query.get("project", "")
        if status not in STATUSES and status not in ("all", "archived"):
            status = "all"
        if project and not _slug(project):
            project = ""
        return cls(project, status)

    def query(self) -> dict[str, str]:
        return {"project": self.project, "status": self.status}


def _slug(value: str) -> bool:
    return value.replace("-", "").isalnum() and len(value) <= 80
