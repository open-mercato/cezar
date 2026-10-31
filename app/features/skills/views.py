from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import Skill
from app.features.skills.urls import SKILLS_CREATE, SKILLS_LIVE, SKILLS_REFRESH, SkillsView


def render(skills: list[Skill], view: SkillsView, chrome: Chrome, tab: str) -> HtmlElement:
    rows = [
        h.Div(
            {"class": "card-block"},
            h.Strong(skill.name),
            h.P({"class": "sub"}, skill.description),
            h.Pre({"class": "diff"}, skill.body[:2_000]),
        )
        for skill in skills
    ] or [h.P({"class": "muted"}, "No skills in .ai/cezar/skills, .ai/skills, or .agents/skills.")]
    return frame(
        chrome,
        SKILLS_LIVE.href(query=view.query()),
        {"tab": tab, "name": "", "description": "", "body": "", "_error": ""},
        h.Main(
            {"id": "skills"},
            h.H1("Skills"),
            h.P(
                {"class": "sub"},
                "Markdown playbooks. The body is added to the agent step that names the skill.",
            ),
            h.Form(
                data.on("submit", at.post(SKILLS_REFRESH.href(query=view.query())), prevent=True),
                h.Button({"class": "btn", "type": "submit"}, "Refresh"),
            ),
            *rows,
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(SKILLS_CREATE.href(query=view.query())), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input({"required": True, "maxlength": "64"}, data.bind("name")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Description"),
                    h.Input({"type": "text", "maxlength": "200"}, data.bind("description")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Body"),
                    h.Textarea({"required": True, "maxlength": "20000"}, data.bind("body")),
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Save skill",
                ),
            ),
        ),
    )
