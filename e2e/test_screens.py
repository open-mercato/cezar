"""One browser walk of each cockpit screen's main action.

Not part of `uv run pytest`. See `e2e/test_main_loop.py` for how to run it.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect
from tests.conftest import init_repo

from browser_launch import launch_chromium


class Cockpit:
    def __init__(self, base: str, repo: Path, data: Path, process: subprocess.Popen[str]) -> None:
        self.base = base
        self.repo = repo
        self.data = data
        self.process = process

    def url(self, path: str) -> str:
        return self.base + path


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_healthy(port: int) -> None:
    import urllib.request

    deadline = time.time() + 20
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError as exc:
            last = str(exc)
        time.sleep(0.1)
    raise AssertionError(last or "cockpit did not listen")


@pytest.fixture(scope="module")
def cockpit(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Cockpit]:
    root = tmp_path_factory.mktemp("screens")
    repo = root / "repo"
    init_repo(repo)
    port = _free_port()
    env = os.environ.copy()
    # Hermetic: the "gh is not authenticated" walk must not see the host's token.
    for name in ("CEZ_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
        env.pop(name, None)
    env.update(
        {
            "CEZ_DRY_RUN": "1",
            "CEZ_REPO": str(repo),
            "PROJECT_DATA_DIR": str(root / "data"),
            "STARIO_HOST": "127.0.0.1",
            "STARIO_PORT": str(port),
            "CEZ_HIDE_TOKEN_USAGE": "0",
            "CEZ_HIDE_COST": "0",
            "CEZ_HIDE_TOKEN_METRICS": "0",
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_healthy(port)
    except Exception:
        process.kill()
        raise
    try:
        yield Cockpit(f"http://127.0.0.1:{port}", repo, root / "data", process)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.fixture
def page(cockpit: Cockpit) -> Iterator[Page]:
    del cockpit
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = launch_chromium(playwright)
        tab = browser.new_page()
        yield tab
        browser.close()


def _click(page: Page, name: str) -> None:
    with page.expect_response(lambda response: response.request.method == "POST") as caught:
        page.get_by_role("button", name=name).click()
    assert caught.value.status in (200, 204, 303)


def _boxes(page: Page) -> tuple[dict[str, float], dict[str, float]]:
    side = page.locator(".sidebar").bounding_box()
    main = page.locator(".main").bounding_box()
    assert side is not None and main is not None
    return side, main


def test_phone_layout_stacks_and_desktop_sits_beside(page: Page, cockpit: Cockpit) -> None:
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(cockpit.url("/tasks"), wait_until="domcontentloaded")
    side, main = _boxes(page)
    assert side["x"] + side["width"] <= main["x"] + 2
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(cockpit.url("/tasks"), wait_until="domcontentloaded")
    side, main = _boxes(page)
    assert side["y"] + side["height"] <= main["y"] + 2
    assert side["width"] > 300


def test_repository_commits_and_workflow_steps(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/git?pane=commits"), wait_until="domcontentloaded")
    expect(page.locator("#git-rows")).to_contain_text("init")
    page.get_by_role("link", name="files").click()
    expect(page.locator("#git-rows")).to_contain_text("README.md")
    page.goto(cockpit.url("/github"), wait_until="domcontentloaded")
    page.get_by_label("Owner").fill("acme")
    page.get_by_label("Repository").fill("app")
    page.get_by_role("button", name="List open issues").click()
    expect(page.locator("#github-notice")).to_contain_text("gh is not authenticated")
    page.goto(cockpit.url("/tracker"), wait_until="domcontentloaded")
    page.get_by_label("Issue key").fill("CEZ-1")
    page.get_by_role("button", name="Look up").click()
    expect(page.locator("#tracker-result")).to_contain_text("jira is not configured")

    page.goto(cockpit.url("/workflows/quick-task"), wait_until="domcontentloaded")
    expect(page.get_by_role("heading", name="quick-task")).to_be_visible()
    expect(page.get_by_text("Do the task")).to_be_visible()
    page.get_by_role("link", name="Start a task").click()
    expect(page).to_have_url(re.compile(r"/tasks/new"))


def test_settings_editors_save(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/settings/tasks"), wait_until="domcontentloaded")
    page.get_by_label("Base branch").fill("main")
    page.get_by_label("Required checks").fill("true")
    _click(page, "Save")
    page.goto(cockpit.url("/settings/tasks"), wait_until="domcontentloaded")
    expect(page.locator("#required-checks")).to_contain_text("true")

    page.goto(cockpit.url("/settings/global-instructions"), wait_until="domcontentloaded")
    page.locator("#global-prompt-input").fill("be brief in the browser")
    _click(page, "Save")
    page.goto(cockpit.url("/settings/global-instructions"), wait_until="domcontentloaded")
    expect(page.locator("#global-prompt")).to_contain_text("be brief in the browser")

    page.goto(cockpit.url("/settings/resources"), wait_until="domcontentloaded")
    page.get_by_label("Memory cap").fill("512")
    _click(page, "Save")
    page.goto(cockpit.url("/settings/resources"), wait_until="domcontentloaded")
    expect(page.locator("#memory-cap")).to_contain_text("512")

    page.goto(cockpit.url("/settings/global-skills"), wait_until="domcontentloaded")
    page.get_by_label("Repository").fill("https://github.com/acme/skills")
    page.get_by_label("Ref").fill("main")
    _click(page, "Add repo")
    page.goto(cockpit.url("/settings/global-skills"), wait_until="domcontentloaded")
    expect(page.locator("#skill-repos")).to_contain_text("acme/skills")

    page.goto(cockpit.url("/settings/tracker"), wait_until="domcontentloaded")
    page.get_by_label("Site").fill("https://acme.atlassian.net")
    page.get_by_label("Email").fill("a@b.co")
    page.get_by_label("Token").fill("secretsecretsecret")
    _click(page, "Save connection")
    page.goto(cockpit.url("/settings/tracker"), wait_until="domcontentloaded")
    expect(page.locator("#tracker-saved")).to_contain_text("A token is saved.")
    expect(page.locator("body")).not_to_contain_text("secretsecretsecret")

    page.goto(cockpit.url("/settings/agents"), wait_until="domcontentloaded")
    expect(page.locator("#agent-bins")).to_contain_text("claude:")
    page.goto(cockpit.url("/settings/worktrees"), wait_until="domcontentloaded")
    expect(page.locator("#worktree-keep")).to_have_text("10")
    page.goto(cockpit.url("/settings/bookmarklets"), wait_until="domcontentloaded")
    expect(page.locator("#bookmarklet")).to_have_attribute(
        "href",
        re.compile(r"^javascript:void\(window\.open\('/tasks/new\?launch=[0-9a-f]+'\)\)$"),
    )

    page.goto(cockpit.url("/secrets"), wait_until="domcontentloaded")
    page.get_by_label("Name").fill("BUILD_TOKEN")
    page.get_by_label("Value").fill("super-secret-value")
    page.get_by_role("button", name="Save secret").click()
    expect(page.locator("#secrets")).to_contain_text("BUILD_TOKEN")
    expect(page.locator("#secrets")).not_to_contain_text("super-secret-value")

    page.goto(cockpit.url("/settings/webhooks"), wait_until="domcontentloaded")
    page.get_by_label("Name").fill("Ship")
    page.get_by_label("URL").fill("http://127.0.0.1:9/hook")
    page.get_by_role("button", name="Save receiver").click()
    expect(page.locator("#receivers")).to_contain_text("Ship")

    page.goto(cockpit.url("/settings/accounts"), wait_until="domcontentloaded")
    page.get_by_label("Name").fill("Ada")
    page.get_by_label("Runner").select_option("codex")
    _click(page, "Add account")
    page.goto(cockpit.url("/settings/accounts"), wait_until="domcontentloaded")
    expect(page.locator("#account-list")).to_contain_text("Ada · codex")

    page.goto(cockpit.url("/settings/agent-config/agents-md"), wait_until="domcontentloaded")
    page.locator("#agent-file-input").fill("# from the browser\n")
    _click(page, "Save")
    page.goto(cockpit.url("/settings/agent-config/agents-md"), wait_until="domcontentloaded")
    expect(page.locator("#agent-file-input")).to_have_value("# from the browser\n")


def test_automations_task_inbox_and_theme(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/automations"), wait_until="domcontentloaded")
    page.get_by_label("Name").fill("Nightly")
    page.get_by_role("textbox", name="Task", exact=True).fill("sweep the logs")
    page.get_by_role("button", name="Add paused automation").click()
    expect(page.locator("#calendar")).to_contain_text("Nightly")
    expect(page.get_by_role("strong").filter(has_text="Nightly")).to_be_visible()
    page.get_by_role("button", name="Enable").click()
    expect(page.get_by_text("enabled")).to_be_visible()

    page.goto(cockpit.url("/tasks/new"), wait_until="domcontentloaded")
    page.get_by_label("Variants").select_option("2")
    page.locator("textarea").fill("compare two notes")
    page.get_by_role("button", name="Start").click()
    page.wait_for_url("**/compare", timeout=15_000)
    expect(page.get_by_text("A", exact=True)).to_be_visible()
    expect(page.get_by_text("B", exact=True)).to_be_visible()

    page.goto(cockpit.url("/tasks/new"), wait_until="domcontentloaded")
    page.locator("textarea").fill("write a note from the browser screens")
    page.get_by_role("button", name="Start").click()
    page.wait_for_url("**/tasks/*", timeout=15_000)
    page.get_by_text("done", exact=True).wait_for(timeout=15_000)
    expect(page.locator("#transcript")).to_contain_text("Dry run finished")
    page.get_by_role("link", name="Terminal").click()
    page.get_by_role("textbox", name="Command", exact=True).fill("echo cezar-pane-ok")
    page.get_by_role("button", name="Run").click()
    expect(page.locator("#shell-output")).to_contain_text("cezar-pane-ok", timeout=10_000)

    page.goto(cockpit.url("/inbox"), wait_until="domcontentloaded")
    expect(page.get_by_text("write a note from the browser screens")).to_be_visible()
    _click(page, "Mark read")
    page.goto(cockpit.url("/inbox"), wait_until="domcontentloaded")
    expect(page.get_by_text("Nothing unread.")).to_be_visible()

    page.goto(cockpit.url("/dashboard"), wait_until="domcontentloaded")
    expect(page.locator("#count-done")).to_be_visible()
    expect(page.locator("#token-total")).to_be_visible()

    page.goto(cockpit.url("/settings/integrations"), wait_until="domcontentloaded")
    _click(page, "Set up e2e")
    page.goto(cockpit.url("/tasks"), wait_until="domcontentloaded")
    expect(page.get_by_text("Tester Army")).to_be_visible()

    page.goto(cockpit.url("/settings"), wait_until="domcontentloaded")
    page.get_by_label("Theme").select_option("light")
    page.get_by_label("Accent").select_option("violet")
    _click(page, "Save")
    page.goto(cockpit.url("/tasks"), wait_until="domcontentloaded")
    expect(page.locator("html")).to_have_class("light")
    expect(page.locator("html")).to_have_attribute("data-accent", "violet")
    color = page.evaluate("getComputedStyle(document.querySelector('.wordmark span')).color")
    assert color == "rgb(109, 40, 217)"


def _block_off_origin(page: Page, cockpit: Cockpit) -> None:
    def handle(route) -> None:
        if route.request.url.startswith(cockpit.base):
            route.continue_()
            return
        route.abort()

    page.route("**/*", handle)


def test_mermaid_fences_render_in_the_transcript(page: Page, cockpit: Cockpit) -> None:
    _block_off_origin(page, cockpit)
    page.goto(cockpit.url("/tasks/new"), wait_until="domcontentloaded")
    page.get_by_label("Workflow").select_option("quick-task")
    page.locator("textarea").fill(
        "draw both\n\n"
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n"
        "```mermaid\nsequenceDiagram\n  Alice->>Bob: hi\n```\n"
    )
    page.get_by_role("button", name="Start").click()
    page.wait_for_url(re.compile(r"/tasks/[0-9a-f]{32}"), timeout=15_000)
    page.locator("#transcript svg").nth(1).wait_for(timeout=15_000)
    diagrams = page.locator("#transcript svg")
    assert diagrams.count() >= 2
    body = page.locator("#transcript").inner_html()
    assert "Alice" in body
    assert "flowchart" in body.lower() or ">B<" in body or ">A<" in body
    assert page.locator("pre.mermaid[data-error]").count() == 0


def test_a_virtual_thread_keeps_sixteen_rows(page: Page, cockpit: Cockpit) -> None:
    steps = "\n".join(
        f"  - id: c{index}\n    name: c{index}\n    command: 'true'" for index in range(24)
    )
    workflow = cockpit.repo / ".ai" / "cezar" / "workflows" / "many-checks.yaml"
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text(f"name: many-checks\nsteps:\n{steps}\n", encoding="utf-8")
    page.goto(cockpit.url("/tasks/new"), wait_until="domcontentloaded")
    page.get_by_label("Workflow").select_option("many-checks")
    page.locator("textarea").fill("run the checks")
    page.get_by_role("button", name="Start").click()
    page.wait_for_url(re.compile(r"/tasks/[0-9a-f]{32}$"), timeout=20_000)
    page.get_by_text("done", exact=True).wait_for(timeout=20_000)
    assert page.locator("#transcript > li").count() > 16
    page.goto(page.url + "?thread=virtual", wait_until="domcontentloaded")
    expect(page.locator("#transcript")).to_have_attribute("data-virtualized", "true")
    expect(page.locator("#transcript > li")).to_have_count(16, timeout=10_000)


def test_the_node_editor_adds_moves_and_connects(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/workflows/review-graph/editor"), wait_until="domcontentloaded")
    _click(page, "Start graph")
    expect(page.locator("#node-implement")).to_be_visible()
    page.locator("#node-id").fill("review")
    _click(page, "Add node")
    expect(page.locator("#node-review")).to_be_visible()
    page.locator("#move-id").select_option("review")
    page.locator("#move-x").fill("300")
    page.locator("#move-y").fill("200")
    _click(page, "Move")
    expect(page.locator("#node-review")).to_have_attribute("data-x", "300", timeout=10_000)
    page.locator("#from-id").select_option("review")
    page.locator("#to-id").select_option("ok")
    _click(page, "Connect")
    expect(page.locator("#graph-edges")).to_contain_text("review → ok")
    _click(page, "Save YAML")
    text = (cockpit.repo / ".ai" / "cezar" / "workflows" / "review-graph.yaml").read_text(
        encoding="utf-8"
    )
    assert "id: review" in text and "x: 300" in text


def _run_git(cwd: Path, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return done.stdout.strip()


def test_a_graph_gate_is_approved_and_rejected_in_the_browser(page: Page, cockpit: Cockpit) -> None:
    graph = (
        "name: ship-gate\nversion: 2\nnodes:\n"
        "  - {id: start, type: start}\n"
        "  - {id: ok, type: end, status: success}\n"
        "  - {id: no, type: end, status: failed}\n"
        "  - {id: ready, type: check, command: 'true'}\n"
        "  - {id: ask, type: gate.human, message: 'ship {{task}}?'}\n"
        "edges:\n"
        "  - {from: start, to: ready}\n"
        "  - {from: ready.pass, to: ask}\n"
        "  - {from: ask.approve, to: ok}\n"
        "  - {from: ask.reject, to: no}\n"
    )
    folder = cockpit.repo / ".ai" / "cezar" / "workflows"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "ship-gate.yaml").write_text(graph, encoding="utf-8")
    for verdict, final in (("Approve", "done"), ("Reject", "failed")):
        page.goto(cockpit.url("/tasks/new"), wait_until="domcontentloaded")
        page.get_by_label("Workflow").select_option("ship-gate")
        page.locator("textarea").fill(f"gate walk {verdict}")
        page.get_by_role("button", name="Start").click()
        page.wait_for_url(re.compile(r"/tasks/[0-9a-f]{32}$"), timeout=15_000)
        expect(page.locator("#gate")).to_be_visible(timeout=15_000)
        expect(page.get_by_text("ship gate walk")).to_be_visible()
        page.locator("#gate textarea").fill("from the browser")
        page.locator("#gate").get_by_role("button", name=verdict).click()
        page.get_by_text(final, exact=True).wait_for(timeout=15_000)
        expect(page.locator("#gate")).to_have_count(0)


def test_an_automation_is_created_then_opened_and_its_log_read(
    page: Page, cockpit: Cockpit
) -> None:
    page.goto(cockpit.url("/automations/new"), wait_until="domcontentloaded")
    expect(page.get_by_role("heading", name="New automation")).to_be_visible()
    page.get_by_role("textbox", name="Name", exact=True).fill("Walk automation")
    page.get_by_role("textbox", name="Task", exact=True).fill("tidy the walk")
    page.get_by_label("Every N minutes").fill("30")
    page.get_by_role("button", name="Add paused automation").click()
    page.wait_for_url(re.compile(r"/automations/[0-9a-f]{32}$"), timeout=15_000)
    expect(page.get_by_role("heading", name="Walk automation")).to_be_visible()
    expect(page.locator("#automation-summary")).to_contain_text("paused")
    page.get_by_role("button", name="Enable").click()
    expect(page.locator("#automation-summary")).to_contain_text("enabled", timeout=10_000)
    page.get_by_role("button", name="Run now").click()
    expect(page.get_by_role("link", name="last run")).to_be_visible(timeout=15_000)
    page.get_by_role("link", name="execution log").click()
    page.wait_for_url(re.compile(r"/automations/[0-9a-f]{32}/log"))
    expect(page.get_by_role("heading", name="Execution log")).to_be_visible()
    expect(page.locator("#log-entries")).to_be_visible()


def test_the_pull_request_detail_reads_the_dry_run_catalog(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/github/prs"), wait_until="domcontentloaded")
    links = page.locator("a[href^='/github/prs/']")
    assert links.count() > 0
    first = links.first
    title = first.inner_text()
    first.click()
    page.wait_for_url(re.compile(r"/github/prs/\d+"))
    expect(page.locator("#pr-body")).to_be_visible()
    expect(page.locator("body")).to_contain_text(title.strip())
    page.goto(page.url + "?pane=changes", wait_until="domcontentloaded")
    expect(page.locator("#pr-changes")).to_be_visible()
    expect(page.locator("#pr-body")).to_have_count(0)


def test_a_commit_opens_its_detail(page: Page, cockpit: Cockpit) -> None:
    sha = _run_git(cockpit.repo, "rev-parse", "HEAD")
    page.goto(cockpit.url("/git?pane=commits"), wait_until="domcontentloaded")
    page.locator(f"a[href='/git/commits/{sha[:7]}']").click()
    page.wait_for_url(re.compile(r"/git/commits/"))
    expect(page.locator("body")).to_contain_text("README.md")
    expect(page.locator(".d-add").first).to_be_visible()
    assert page.goto(cockpit.url("/git/commits/deadbeef")).status == 404


def test_accounts_show_signed_in_state_and_details(page: Page, cockpit: Cockpit) -> None:
    page.goto(cockpit.url("/settings/accounts"), wait_until="domcontentloaded")
    page.get_by_label("Name").fill("Status Work")
    page.get_by_label("Runner").select_option("claude")
    _click(page, "Add account")
    page.goto(cockpit.url("/settings/accounts"), wait_until="domcontentloaded")
    link = page.get_by_role("link", name="Status Work · claude")
    expect(link).to_be_visible()
    account_id = (link.get_attribute("href") or "").rsplit("/", 1)[-1]
    item = page.locator("#account-list").locator("li").filter(has_text="Status Work")
    expect(item).to_contain_text("not signed in")
    (cockpit.data / "agent-homes" / account_id / ".claude.json").write_text(
        '{"oauthAccount": {"emailAddress": "walk@example.com", "displayName": "W"}}',
        encoding="utf-8",
    )
    page.goto(cockpit.url("/settings/accounts"), wait_until="domcontentloaded")
    expect(item).to_contain_text("signed in")
    expect(item).not_to_contain_text("not signed in")
    expect(page.locator("body")).not_to_contain_text("walk@example.com")
    page.get_by_role("link", name="Status Work · claude").click()
    page.wait_for_url(re.compile(r"/settings/accounts/"))
    expect(page.locator("body")).to_contain_text("walk@example.com")
