import asyncio

from litewriter import LiteWriter
from stario import App, Relay, Span, serve
from stario.http import same_origin, security_headers

from app.assets import ASSETS
from app.config import Config, listen_config
from app.engine.engine import Engine
from app.features.api.closeout import CloseoutApi
from app.features.api.families import RouteFamilies
from app.features.api.handlers import ApiPage
from app.features.api.surface import SurfaceApi
from app.features.automations.handlers import AutomationsPage
from app.features.commit.handlers import CommitPages
from app.features.dashboard.handlers import DashboardPage
from app.features.editors.accounts import AccountsPage
from app.features.editors.handlers import EditorsPage
from app.features.github.handlers import GithubPages
from app.features.health.handlers import HealthPage
from app.features.places.handlers import PlacesPage
from app.features.projects.handlers import ProjectsPage
from app.features.secrets.handlers import SecretsPage
from app.features.settings.handlers import SettingsPage
from app.features.skills.handlers import SkillsPage
from app.features.task.handlers import TaskPage
from app.features.tasks.handlers import TasksPage
from app.features.tracker.handlers import TrackerItemPage
from app.features.workflows.editor import EditorPage
from app.features.workflows.handlers import WorkflowsPage
from app.http.basic_auth import basic_auth
from app.http.loopback import loopback_host_guard
from app.store.db import schema


async def bootstrap(app: App, span: Span):
    config = Config.from_env()
    async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
        relay: Relay[dict[str, str]] = Relay()
        engine = Engine(db, relay, config)
        engine.app = app
        app.use("/", same_origin(), security_headers(), basic_auth(config))
        app.use("/api", loopback_host_guard(config))
        span.attrs(await ASSETS.attach(app))
        span.attr("app.name", config.app_name)
        await engine.startup()
        TasksPage(db, relay, engine, config).register(app)
        TaskPage(db, relay, engine, config).register(app)
        WorkflowsPage(db, relay, engine, config).register(app)
        EditorPage(db, relay, engine, config).register(app)
        SkillsPage(db, relay, engine, config).register(app)
        AutomationsPage(db, relay, engine, config).register(app)
        DashboardPage(db, relay, engine, config).register(app)
        ProjectsPage(db, relay, engine, config).register(app)
        SettingsPage(db, relay, engine, config).register(app)
        SecretsPage(db, engine, config).register(app)
        PlacesPage(db, engine, config).register(app)
        GithubPages(db, engine, config).register(app)
        TrackerItemPage(db, engine, config).register(app)
        CommitPages(db, engine, config).register(app)
        EditorsPage(db, engine, config).register(app)
        AccountsPage(db, engine, config).register(app)
        HealthPage(db, engine, config).register(app)
        ApiPage(db, engine, config).register(app)
        SurfaceApi(db, engine, config).register(app)
        RouteFamilies(db, engine, config).register(app)
        CloseoutApi(db, engine, config).register(app)
        app.create_task(engine.serve())
        yield


def main() -> None:
    asyncio.run(serve(bootstrap, config=listen_config()))


if __name__ == "__main__":
    main()
