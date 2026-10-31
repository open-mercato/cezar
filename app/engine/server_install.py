"""Install, deploy, and remove the cockpit through the host's service tools.

The commands are injectable. A dry run returns them and does not write files
or spawn anything. Linux uses `systemctl --user`; macOS uses `launchctl`.
Deploy and uninstall also speak `docker compose`.
"""

from __future__ import annotations

import socket
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

Runner = Callable[[list[str]], tuple[int, str]]


def first_free_port(host: str, start: int, span: int = 20) -> int:
    for port in range(start, start + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    return start


def command_runner(args: list[str]) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return result.returncode, (result.stdout or result.stderr).strip()


def install_service(
    dest: Path,
    *,
    host: str,
    port: int,
    repo: str,
    dry_run: bool,
    runner: Runner | None = None,
) -> dict[str, object]:
    commands = _service_commands(dest, enable=True)
    if dry_run:
        return {"ok": True, "dryRun": True, "commands": commands, "files": []}
    names = install_files(dest, host=host, port=port, repo=repo)
    failure = _run_all(commands, runner or command_runner)
    if failure:
        return {"ok": False, "error": failure, "files": names, "commands": commands}
    return {"ok": True, "dryRun": False, "files": names, "commands": commands}


def deploy_service(
    dest: Path,
    *,
    host: str,
    port: int,
    dry_run: bool,
    runner: Runner | None = None,
) -> dict[str, object]:
    commands = _compose_commands(dest, up=True)
    if dry_run:
        return {"ok": True, "dryRun": True, "commands": commands, "files": []}
    name = deploy_compose(dest, host=host, port=port)
    failure = _run_all(commands, runner or command_runner)
    if failure:
        return {"ok": False, "error": failure, "files": [name], "commands": commands}
    return {"ok": True, "dryRun": False, "files": [name], "commands": commands}


def uninstall_service(
    dest: Path, *, dry_run: bool, runner: Runner | None = None
) -> dict[str, object]:
    commands = [*_service_commands(dest, enable=False), *_compose_commands(dest, up=False)]
    if dry_run:
        return {"ok": True, "dryRun": True, "commands": commands, "files": []}
    failure = _run_all(commands, runner or command_runner)
    removed = uninstall_files(dest)
    if failure:
        return {"ok": False, "error": failure, "files": removed, "commands": commands}
    return {"ok": True, "dryRun": False, "files": removed, "commands": commands}


def install_files(dest: Path, *, host: str, port: int, repo: str) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    unit = dest / "cezar.service"
    compose = dest / "compose.yaml"
    unit.write_text(_unit(host, port, repo), encoding="utf-8")
    compose.write_text(_compose(host, port), encoding="utf-8")
    return [unit.name, compose.name]


def deploy_compose(dest: Path, *, host: str, port: int) -> str:
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / "compose.yaml"
    path.write_text(_compose(host, port), encoding="utf-8")
    return path.name


def uninstall_files(dest: Path) -> list[str]:
    removed: list[str] = []
    for name in ("cezar.service", "compose.yaml"):
        path = dest / name
        if path.is_file():
            path.unlink()
            removed.append(name)
    return removed


def _service_commands(dest: Path, *, enable: bool) -> list[list[str]]:
    unit = dest / "cezar.service"
    if sys.platform == "darwin":
        target = ["launchctl", "bootstrap" if enable else "bootout", "gui/0", str(unit)]
        return [target]
    if enable:
        return [
            ["systemctl", "--user", "link", str(unit)],
            ["systemctl", "--user", "enable", "--now", "cezar.service"],
        ]
    return [["systemctl", "--user", "disable", "--now", "cezar.service"]]


def _compose_commands(dest: Path, *, up: bool) -> list[list[str]]:
    compose = dest / "compose.yaml"
    verb = ["up", "-d"] if up else ["down"]
    return [["docker", "compose", "-f", str(compose), *verb]]


def _run_all(commands: list[list[str]], runner: Runner) -> str | None:
    for command in commands:
        code, text = runner(command)
        if code != 0:
            return text or f"{' '.join(command)} failed"
    return None


def _unit(host: str, port: int, repo: str) -> str:
    return (
        "[Unit]\n"
        "Description=cezar cockpit\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={repo}\n"
        f"Environment=STARIO_HOST={host}\n"
        f"Environment=STARIO_PORT={port}\n"
        "ExecStart=python -m app.main\n"
        "Restart=on-failure\n"
        "\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )


def _compose(host: str, port: int) -> str:
    return (
        "services:\n"
        "  cezar:\n"
        "    build: .\n"
        f"    ports:\n      - {host}:{port}:{port}\n"
        "    command: [python, -m, app.main]\n"
    )
