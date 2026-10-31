from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

AUTOMATIONS = Route("GET /automations")
AUTOMATIONS_LIVE = Route("GET /automations/live")
AUTOMATIONS_NEW = Route("GET /automations/new")
AUTOMATIONS_CREATE = Route("POST /automations")
AUTOMATION = Route("GET /automations/{automation_id}")
AUTOMATION_LIVE = Route("GET /automations/{automation_id}/live")
AUTOMATION_UPDATE = Route("POST /automations/{automation_id}/update")
AUTOMATION_LOG = Route("GET /automations/{automation_id}/log")
AUTOMATION_LOG_LIVE = Route("GET /automations/{automation_id}/log/live")
AUTOMATION_CHECK = Route("POST /automations/{automation_id}/check")
AUTOMATION_RETRY = Route("POST /automations/{automation_id}/log/{entry_id}/retry")
AUTOMATIONS_ENABLE = Route("POST /automations/{automation_id}/enable")
AUTOMATIONS_PAUSE = Route("POST /automations/{automation_id}/pause")
AUTOMATIONS_RUN = Route("POST /automations/{automation_id}/run")
AUTOMATIONS_DELETE = Route("POST /automations/{automation_id}/delete")


@dataclass(frozen=True, slots=True)
class AutomationsView:
    project: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> AutomationsView:
        project = query.get("project", "")
        if project and not project.replace("-", "").isalnum():
            project = ""
        return cls(project)

    def query(self) -> dict[str, str]:
        return {"project": self.project}


@dataclass(frozen=True, slots=True)
class LogView:
    """Which check the log page opens: `?entry=<id>` is the check detail."""

    entry: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> LogView:
        entry = query.get("entry", "")
        return cls(entry if len(entry) == 32 and entry.isalnum() else "")

    def query(self) -> dict[str, str]:
        return {"entry": self.entry} if self.entry else {}
