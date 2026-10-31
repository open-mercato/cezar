"""One settings index. Every settings page renders it, so a section is reachable."""

from stario import Route, h
from stario.markup import HtmlElement

from app.features.editors.urls import (
    ACCOUNTS,
    AGENT_CONFIG,
    BOOKMARKLETS,
    INSTRUCTIONS,
    INTEGRATIONS,
    KEYBOARD,
    NOTIFICATIONS,
)
from app.features.places.urls import (
    SETTINGS_AGENTS,
    SETTINGS_PRIVACY,
    SETTINGS_WEBHOOKS,
    SETTINGS_WORKTREES,
)
from app.features.secrets.urls import SECRETS
from app.features.settings.urls import (
    GLOBAL_INSTRUCTIONS,
    GLOBAL_SKILLS,
    RESOURCES,
    SETTINGS,
    TASKS_SETTINGS,
    TRACKER_SETTINGS,
)


def settings_nav() -> HtmlElement:
    links: tuple[tuple[Route, str], ...] = (
        (SETTINGS, "Appearance"),
        (TASKS_SETTINGS, "Tasks"),
        (TRACKER_SETTINGS, "Tracker"),
        (SECRETS, "Secrets"),
        (SETTINGS_AGENTS, "Agents"),
        (SETTINGS_WEBHOOKS, "Webhooks"),
        (SETTINGS_WORKTREES, "Worktrees"),
        (INSTRUCTIONS, "Instructions"),
        (GLOBAL_INSTRUCTIONS, "Global instructions"),
        (GLOBAL_SKILLS, "Skills"),
        (RESOURCES, "Resources"),
        (AGENT_CONFIG, "Agent config"),
        (ACCOUNTS, "Accounts"),
        (NOTIFICATIONS, "Notifications"),
        (KEYBOARD, "Keyboard"),
        (BOOKMARKLETS, "Bookmarklets"),
        (INTEGRATIONS, "Integrations"),
        (SETTINGS_PRIVACY, "Privacy"),
    )
    return h.Nav(
        {"class": "filters", "id": "settings-nav"},
        *[h.A({"href": route.href()}, label) for route, label in links],
    )
