"""`python -m app.cli` — serve, run, init, projects.

`run` treats `review` as success (exit 0), the same rule as headless `cezar run`.
If a cockpit already holds the database, the command says so instead of waiting out the lock.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from litewriter import ClaimBusy, LiteWriter
from stario import Relay, serve
from stario.http.config import ServerConfig

from app.cli_commands import (
    run_automation_command,
    run_runs_command,
    run_secrets_command,
    run_task_command,
    run_telemetry_command,
    run_tracker_connections_command,
)
from app.clock import stamp
from app.config import RUNNERS, Config, apply_overrides, single_project
from app.engine.engine import Engine
from app.engine.import_runs import events_near, load_runs_file
from app.engine.scaffold import init_project
from app.engine.server_install import (
    deploy_service,
    first_free_port,
    install_service,
    uninstall_service,
)
from app.main import bootstrap
from app.store.db import (
    add_event,
    find_project_by_root,
    get_run,
    get_settings,
    insert_run,
    list_events,
    list_projects,
    schema,
)


def main(argv: list[str] | None = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--repo", default="")
    common.add_argument("--port", type=int, default=0)
    common.add_argument("--host", default="")
    parser = argparse.ArgumentParser(
        prog="cezar-py", description="Python cockpit for cezar", parents=[common]
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("serve", parents=[common])

    run_parser = sub.add_parser("run", parents=[common])
    run_parser.add_argument("task", nargs="+")
    run_parser.add_argument("--workflow", default="quick-task")
    run_parser.add_argument("--runner", default="")
    run_parser.add_argument("--model", default="")

    sub.add_parser("init", parents=[common])

    projects = sub.add_parser("projects", parents=[common])
    projects.add_argument("action", nargs="?", default="list")
    projects.add_argument("value", nargs="?")
    projects.add_argument("tags", nargs="*")

    importer = sub.add_parser("import-runs", parents=[common])
    importer.add_argument("path")

    for name in ("task", "automation", "runs", "secrets", "telemetry", "tracker-connections"):
        extra = sub.add_parser(name)
        extra.add_argument("rest", nargs=argparse.REMAINDER)

    for name in ("server-install", "uninstall", "deploy", "package"):
        extra = sub.add_parser(name, parents=[common])
        extra.add_argument("--dest", required=True)

    args = parser.parse_args(argv)
    if args.repo:
        apply_overrides(repo=args.repo)
    command = args.command or "serve"
    if command == "serve":
        config = Config.from_env()
        host = args.host or config.listen_host
        port = args.port or config.listen_port
        from app.engine.skills_banner import print_skills_banner

        print_skills_banner(config.repo_root)
        if args.port == 0:
            port = first_free_port(host, port)
        asyncio.run(serve(bootstrap, config=ServerConfig(host=host, port=port)))
        return 0
    if command in ("server-install", "uninstall", "deploy", "package"):
        return _files_command(command, args)
    if command == "init":
        repo = Config.from_env().repo_root
        print(f"initialized {repo}")
        for line in init_project(repo):
            print(line)
        return 0
    try:
        if command == "run":
            return asyncio.run(
                run_task(
                    " ".join(args.task),
                    workflow=args.workflow,
                    runner=args.runner,
                    model=args.model,
                )
            )
        if command == "import-runs":
            return asyncio.run(import_runs_command(Path(args.path)))
        if command == "task":
            return run_task_command(args.rest, dict(os.environ), _out, _err)
        if command == "automation":
            return run_automation_command(args.rest, dict(os.environ), _out, _err)
        if command == "runs":
            return run_runs_command(args.rest, dict(os.environ), _out, _err)
        if command == "secrets":
            return asyncio.run(
                run_secrets_command(args.rest, read_value=_stdin, log=_out, error=_err)
            )
        if command == "tracker-connections":
            return run_tracker_connections_command(args.rest, _out, _err)
        if command == "telemetry":
            return run_telemetry_command(args.rest, _out, _err)
        return asyncio.run(projects_command(args.action, args.value, args.tags))
    except ClaimBusy:
        print("the database is in use by a running cockpit", file=sys.stderr)
        return 1


async def run_task(task: str, *, workflow: str, runner: str, model: str) -> int:
    config = Config.from_env()
    async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
        relay: Relay[dict[str, str]] = Relay()
        engine = Engine(db, relay, config)
        await engine.startup()
        project = find_project_by_root(db, str(config.repo_root))
        if project is None:
            print("this directory is not a project", file=sys.stderr)
            return 1
        chosen = runner or get_settings(db).default_runner
        if chosen not in RUNNERS:
            print(f"unknown runner {chosen}", file=sys.stderr)
            return 1
        run, reason = engine.plan_run(
            project=project,
            task=task,
            workflow_name=workflow,
            runner=chosen,
            model=model,
        )
        if run is None:
            print(reason or "invalid task", file=sys.stderr)
            return 1
        await engine.enqueue(run)
        await engine.execute(run.id)
        current = get_run(db, run.id)
        for event in list_events(db, run.id):
            print(f"{event.type}: {event.text}")
        status = current.status if current else "failed"
        print(status)
        if status in ("review", "done"):
            return 0
        return 1


async def import_runs_command(path: Path) -> int:
    config = Config.from_env()
    async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
        relay: Relay[dict[str, str]] = Relay()
        engine = Engine(db, relay, config)
        await engine.startup()
        project = find_project_by_root(db, str(config.repo_root))
        if project is None:
            print("this directory is not a project", file=sys.stderr)
            return 1
        try:
            runs, skipped = load_runs_file(path, project.id)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        stored = 0
        for run in runs:
            if get_run(db, run.id) is not None:
                skipped += 1
                continue
            await db.write(insert_run, run)
            for event in events_near(path, run.id):
                await db.write(
                    add_event,
                    run.id,
                    event["type"],
                    event["text"],
                    event["step_id"],
                    event["at"] or stamp(),
                )
            stored += 1
        print(f"imported {stored}, skipped {skipped}")
        return 0


async def projects_command(action: str, value: str | None, tags: list[str] | None = None) -> int:
    config = Config.from_env()
    async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
        relay: Relay[dict[str, str]] = Relay()
        engine = Engine(db, relay, config)
        await engine.startup()
        if action in ("", "list"):
            for project in list_projects(db):
                print(f"{project.id}\t{project.root}")
            return 0
        if action in ("add", "remove", "rm", "tag") and single_project():
            print(
                "add/remove/tag are unavailable when CEZ_SINGLE_PROJECT=1",
                file=sys.stderr,
            )
            return 1
        if action == "add":
            path = Path(value) if value else config.repo_root
            project, reason = await engine.add_project(path)
            if project is None:
                print(reason or "could not add", file=sys.stderr)
                return 1
            print(f"{project.id}\t{project.root}")
            return 0
        if action == "tag":
            from dataclasses import replace

            from app.store.db import get_project, save_project

            found = get_project(db, value) if value else None
            if found is None:
                print("projects tag <id> [<tag>...]: not found", file=sys.stderr)
                return 1
            kept: list[str] = []
            for tag in tags or []:
                clean = tag.strip()
                if clean and clean.lower() not in (item.lower() for item in kept):
                    kept.append(clean)
            await db.write(save_project, replace(found, tags=tuple(kept)))
            print(f"{found.id}\t[{' '.join(kept)}]" if kept else f"{found.id}\t(no tags)")
            return 0
        if action in ("remove", "rm"):
            if not value:
                print("projects remove <id>", file=sys.stderr)
                return 1
            from app.store.db import delete_project, get_project

            if get_project(db, value) is None:
                print("not found", file=sys.stderr)
                return 1
            await db.write(delete_project, value)
            print(f"removed {value}")
            return 0
        print(f"unknown projects action: {action}", file=sys.stderr)
        return 1


def _files_command(command: str, args: argparse.Namespace) -> int:
    """Install or remove the cockpit. A dry run prints the commands and stops."""
    config = Config.from_env()
    dest = Path(args.dest)
    host = args.host or "127.0.0.1"
    port = args.port or 4321
    if command == "server-install":
        result = install_service(
            dest, host=host, port=port, repo=str(config.repo_root), dry_run=config.dry_run
        )
    elif command == "deploy":
        result = deploy_service(dest, host=host, port=port, dry_run=config.dry_run)
    elif command == "uninstall":
        result = uninstall_service(dest, dry_run=config.dry_run)
    else:
        return _package(dest)
    return _print_service(result)


def _package(dest: Path) -> int:
    """Build the wheel and sdist with `uv build`."""
    root = Path.cwd()
    if not (root / "pyproject.toml").is_file():
        root = Path(__file__).resolve().parents[1]
    dest.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        ["uv", "build", "--out-dir", str(dest)],
        cwd=root,
        check=False,
    )
    return completed.returncode


def _print_service(result: dict[str, object]) -> int:
    if result.get("ok") is not True:
        print(str(result.get("error") or "the service command failed"), file=sys.stderr)
        return 1
    if result.get("dryRun") is True:
        print("dry-run")
        commands = result.get("commands")
        if isinstance(commands, list):
            for command in commands:
                if isinstance(command, list):
                    print(" ".join(str(part) for part in command))
        return 0
    files = result.get("files")
    if isinstance(files, list):
        print(" ".join(str(name) for name in files))
    return 0


def _out(line: str) -> None:
    print(line)


def _err(line: str) -> None:
    print(line, file=sys.stderr)


def _stdin() -> str:
    return sys.stdin.read()


if __name__ == "__main__":
    raise SystemExit(main())
