from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

GITHUB_PRS = Route("GET /github/prs")
GITHUB_PR = Route("GET /github/prs/{number}")
GITHUB_ISSUE = Route("GET /github/issues/{number}")

PR_PANES = ("conversation", "changes")


@dataclass(frozen=True, slots=True)
class PrView:
    pane: str = "conversation"

    @classmethod
    def from_query(cls, query: ParsedQuery) -> PrView:
        pane = query.get("pane", "conversation")
        return cls(pane if pane in PR_PANES else "conversation")

    def query(self) -> dict[str, str]:
        return {"pane": self.pane}
