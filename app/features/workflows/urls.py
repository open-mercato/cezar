from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

WORKFLOWS = Route("GET /workflows")
WORKFLOWS_LIVE = Route("GET /workflows/live")
WORKFLOWS_CREATE = Route("POST /workflows")
WORKFLOWS_DELETE = Route("POST /workflows/{name}/delete")
EDITOR = Route("GET /workflows/{name}/editor")
EDITOR_LIVE = Route("GET /workflows/{name}/editor/live")
EDITOR_START = Route("POST /workflows/{name}/editor/start")
EDITOR_ADD = Route("POST /workflows/{name}/editor/node")
EDITOR_MOVE = Route("POST /workflows/{name}/editor/move")
EDITOR_CONNECT = Route("POST /workflows/{name}/editor/connect")
EDITOR_SAVE = Route("POST /workflows/{name}/editor/save")


@dataclass(frozen=True, slots=True)
class WorkflowsView:
    project: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> WorkflowsView:
        project = query.get("project", "")
        if project and not project.replace("-", "").isalnum():
            project = ""
        return cls(project)

    def query(self) -> dict[str, str]:
        return {"project": self.project}
