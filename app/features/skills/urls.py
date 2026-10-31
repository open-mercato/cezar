from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

SKILLS = Route("GET /skills")
SKILLS_LIVE = Route("GET /skills/live")
SKILLS_CREATE = Route("POST /skills")
SKILLS_REFRESH = Route("POST /skills/refresh")


@dataclass(frozen=True, slots=True)
class SkillsView:
    project: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> SkillsView:
        project = query.get("project", "")
        if project and not project.replace("-", "").isalnum():
            project = ""
        return cls(project)

    def query(self) -> dict[str, str]:
        return {"project": self.project}
