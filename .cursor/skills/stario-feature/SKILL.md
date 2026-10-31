---
name: stario-feature
description: Add, change, or remove a page (a resource with its own URL) in a Stario app. Use when the user asks for a new page or route, wants a page to update live or in every tab, adds a button, form, command, edit dialog, search box, sort, filter, or background job to a page, fixes a page that does not refresh, deletes a page, or needs a browser check. Has complete files for a static page, a private read, a live page with a view in the URL and messages to one tab, slow work, and an edit dialog, plus a browser check script.
---

# Add, change, or remove a page

`AGENTS.md` holds the rules. This skill holds the steps and complete files. Every file below passed `just check` in a real app. To change an existing page, read its folder first, then use the example that matches the change.

## Decide first

1. The resource. The path names it: `/todos`, `/rooms/{room_id}`. One folder `app/features/<page>/`, named after the URL noun.
2. The view, if any. Which query parameters decide what this tab sees: sort, filter, page number. They go in a `View` in `urls.py`. Most pages have none.
3. The actions (`AGENTS.md`, A page is a resource). Only commands make a page live: page `GET`, `GET .../live`, one `POST` per command.
4. The stream source. Rows in SQLite: `db.watch` (the common case). A command that must tell its own tab something after the work (a conflict, a toast): `Relay` with a tab id.
5. State. None, an object built in `bootstrap`, or tables in `data.py`. Ask the developer before you add a database.
6. Slow work. A command that waits on something slow becomes a job.

## Steps

1. `app/features/<page>/__init__.py`, `urls.py`, `views.py`, `handlers.py`, and `data.py` when the page owns state.
2. `app/main.py`: build the shared objects once, then `TodosPage(db, relay).register(app)` before `yield`. Join the schema functions of every page into one `schema(tx)`.
3. A link from another page: import its `urls.py`: `h.A({"href": TODOS.href(query={"sort": "title"})}, ...)`.
4. `tests/test_<page>.py`: the page loads; the view follows the query; a command repaints the stream; bad input gets 4xx. Assert the changed HTML in the next SSE event. Do not open a browser for that.
5. `just check`. Fix every failure. A browser is only for what `AGENTS.md` (Checks) names.

## API

Load skill `stario-api` with this one. It has every signature: `c`, `w`, `h.*`, Relay, TestClient, `data.*`, `at.*`, `SSE`. Do not read `site-packages`.

## A static page

```python
# urls.py
from stario import Route

ABOUT = Route("GET /about")
```

```python
# views.py
from stario import h
from stario.markup import HtmlElement

from app.common.shell import page


def render(version: str) -> HtmlElement:
    return page("About", h.Main({"id": "about"}, h.H1("About"), h.P(f"Version {version}")))
```

```python
# handlers.py
from dataclasses import dataclass

from stario import App, Context, Writer

from app.features.about.urls import ABOUT
from app.features.about.views import render


@dataclass(frozen=True, slots=True)
class AboutPage:
    version: str

    def register(self, app: App) -> None:
        app.add(ABOUT, self.show)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(render(self.version))
```

`version` is a `Config` field. The page never reads `os.environ`.

## A private read (search as you type)

A result that only this tab needs while the user types. It changes no state, so it needs no stream.

```python
# urls.py
SEARCH = Route("GET /search")
SEARCH_RESULTS = Route("GET /search/results")
```

```python
# views.py: the page, and the part the read replaces
def results(matches: list[str], total: int) -> HtmlElement:
    return h.Div({"id": "results"}, h.P(f"{total} matches"), h.Ul(*[h.Li(m) for m in matches]))


def render(matches: list[str], total: int) -> HtmlElement:
    return page(
        "Search",
        h.Main(
            {"id": "search"},
            data.signals({"q": ""}, if_missing=True),
            h.Input(
                {"type": "search"},
                data.bind("q"),
                data.on("input", at.get(SEARCH_RESULTS.href()), debounce="200ms"),
            ),
            results(matches, total),
        ),
    )
```

```python
# handlers.py
@dataclass(frozen=True, slots=True)
class SearchPage:
    cities: tuple[str, ...]

    def register(self, app: App) -> None:
        app.add(SEARCH, self.show)
        app.add(SEARCH_RESULTS, self.results)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(render(list(self.cities[:20]), len(self.cities)))

    async def results(self, c: Context, w: Writer) -> None:
        q = str((await read_signals(c.req)).get("q", "")).strip().lower()
        found = [city for city in self.cities if q in city.lower()]
        SSE(w).patch_elements(results(found[:20], len(found)))
```

Test it with `client.get(SEARCH_RESULTS.href(), params={"datastar": '{"q": "par"}'})`. Do not patch the input again: a repaint of a control loses what the user typed. When the search must survive a reload or a shared link, make `q` part of the view instead: a `<form>` with `method="get"` reloads the page with `?q=`.

## A live page

The common case: a shared todo list in SQLite (skill `stario-litewriter`). The stream follows `db.watch`, so the commands only write. No view, no tab id, no `Relay`.

```python
# urls.py
from stario import Route

TODOS = Route("GET /todos")
TODOS_LIVE = Route("GET /todos/live")
ADD_TODO = Route("POST /todos")
TOGGLE_TODO = Route("POST /todos/{todo_id}/toggle")
```

```python
# data.py
from dataclasses import dataclass

from litewriter import LiteWriter, Tx
from stario.json import dumps

COLUMNS = {
    "title": "TEXT AS (data->>'title')",
    "done": "INTEGER AS (data->>'done')",
}

ITEMS = "SELECT id, title, done FROM todos ORDER BY id"


@dataclass(frozen=True, slots=True)
class Todo:
    id: int
    title: str
    done: int


def schema(tx: Tx) -> None:
    tx.execute(
        "CREATE TABLE IF NOT EXISTS todos ("
        " id INTEGER PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)))"
    )
    have = {row[0] for row in tx.query("SELECT name FROM pragma_table_xinfo('todos')")}
    for name, column in COLUMNS.items():
        if name not in have:
            tx.execute(f"ALTER TABLE todos ADD COLUMN {name} {column} VIRTUAL")


def list_todos(db: LiteWriter) -> list[Todo]:
    return db.query(ITEMS, Todo)


def get_todo(db: LiteWriter, todo_id: int) -> Todo | None:
    return db.one("SELECT id, title, done FROM todos WHERE id = :id", Todo, id=todo_id)


def add_todo(tx: Tx, title: str) -> int:
    return tx.value(
        "INSERT INTO todos (data) VALUES (:data) RETURNING id",
        data=dumps({"title": title, "done": False}),
    )


def toggle_done(tx: Tx, todo_id: int) -> None:
    tx.execute(
        "UPDATE todos SET data = json_set(data, '$.done', json(iif(done, 'false', 'true')))"
        " WHERE id = :id",
        id=todo_id,
    )
```

```python
# views.py
from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import page
from app.features.todos.data import Todo
from app.features.todos.urls import ADD_TODO, TODOS_LIVE, TOGGLE_TODO


def render(items: list[Todo]) -> HtmlElement:
    return page(
        "Todos",
        h.Main(
            {"id": "todos"},
            data.signals({"title": ""}, if_missing=True),
            data.init(at.get(TODOS_LIVE.href(), retry="always")),
            h.H1("Todos"),
            h.Form(
                data.on("submit", at.post(ADD_TODO.href()), prevent=True),
                data.indicator("_adding"),
                h.Input(
                    {
                        "type": "text",
                        "placeholder": "What needs doing?",
                        "autocomplete": "off",
                        "required": True,
                    },
                    data.bind("title"),
                ),
                h.Button({"type": "submit"}, data.attr("disabled", "$_adding"), "Add"),
            ),
            h.Ul(*[item(t) for t in items]) if items else h.P("Nothing to do yet."),
        ),
    )


def item(t: Todo) -> HtmlElement:
    return h.Li(
        h.Label(
            h.Input(
                {"type": "checkbox", "checked": bool(t.done)},
                data.on("click", at.post(TOGGLE_TODO.href(t.id)), prevent=True),
            ),
            h.S(t.title) if t.done else t.title,
        )
    )
```

```python
# handlers.py
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer
from stario.datastar import SSE, read_signals

from app.features.todos.data import ITEMS, Todo, add_todo, get_todo, list_todos, toggle_done
from app.features.todos.urls import ADD_TODO, TODOS, TODOS_LIVE, TOGGLE_TODO
from app.features.todos.views import render


@dataclass(frozen=True, slots=True)
class TodosPage:
    db: LiteWriter

    def register(self, app: App) -> None:
        app.add(TODOS, self.show)
        app.add(TODOS_LIVE, self.live)
        app.add(ADD_TODO, self.add)
        app.add(TOGGLE_TODO, self.toggle)

    async def show(self, c: Context, w: Writer) -> None:
        w.html(render(list_todos(self.db)))

    async def live(self, c: Context, w: Writer) -> None:
        sse = SSE(w)
        async with self.db.watch(ITEMS, Todo) as rows:
            async for todos in c.alive(rows):
                sse.patch_elements(render(todos))

    async def add(self, c: Context, w: Writer) -> None:
        title = str((await read_signals(c.req)).get("title", "")).strip()
        if not title or len(title) > 200:
            w.text("title must be 1 to 200 characters", status=400)
            return
        SSE(w).patch_signals({"title": ""})
        await self.db.write(add_todo, title)

    async def toggle(self, c: Context, w: Writer) -> None:
        todo_id = c.match.params["todo_id"]
        if not todo_id.isdecimal() or get_todo(self.db, int(todo_id)) is None:
            w.text("no such todo", status=404)
            return
        w.empty()
        await self.db.write(toggle_done, int(todo_id))
```

```python
# tests/test_todos.py
async def test_add_repaints_the_stream(client):
    async with client.stream("GET", TODOS_LIVE.href()) as live:
        events = live.iter_events()
        assert 'id="todos"' in (await anext(events))["data"]
        r = await client.post(ADD_TODO.href(), json={"title": "Buy milk"})
        assert r.status_code == 200
        assert "Buy milk" in (await anext(events))["data"]


async def test_toggle_repaints_the_stream(client):
    await client.post(ADD_TODO.href(), json={"title": "Buy milk"})
    async with client.stream("GET", TODOS_LIVE.href()) as live:
        events = live.iter_events()
        first = (await anext(events))["data"]
        assert "Buy milk" in first
        assert "checked" not in first
        r = await client.post(TOGGLE_TODO.href(1))
        assert r.status_code == 204
        assert "checked" in (await anext(events))["data"]
```

`add` replies with `patch_signals` to clear the input, then awaits the write; the commit wakes the watch, and every open tab repaints. `main.py` builds the `LiteWriter` once and passes it: `TodosPage(db).register(app)`.

Add more only when the page needs it:

- A sort, a filter, or paging: a `View` in `urls.py` (next section).
- A message to the tab that sent a command (a conflict, a toast): a tab id and `Relay` (next section, and Messages to one tab).
- State in memory, not SQLite: the stream follows `relay.subscribe(CHANGED, latest=True)`, and each command publishes `CHANGED` after it changes the state.

## A view and messages to one tab

The same list with the sort and the filter in the URL. A duplicate title is a message to the tab that sent it.

```python
# urls.py
from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

TODOS = Route("GET /todos")
TODOS_LIVE = Route("GET /todos/live")
ADD_TODO = Route("POST /todos")
TOGGLE_TODO = Route("POST /todos/{todo_id}/toggle")

SORTS = ("new", "title")


@dataclass(frozen=True, slots=True)
class TodosView:
    sort: str = "new"
    hide_done: bool = False

    @classmethod
    def from_query(cls, query: ParsedQuery) -> TodosView:
        sort = query.get("sort", "new")
        return cls(sort if sort in SORTS else "new", query.get("hide_done") == "1")

    def query(self) -> dict[str, str]:
        return {"sort": self.sort, "hide_done": "1" if self.hide_done else "0"}
```

An unknown value falls back to the default, so an old link still opens.

```python
# data.py: the table above, plus a unique title and one query per view
ORDER = {"new": "id DESC", "title": "lower(title)"}

# in schema(), after the columns:
tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS todos_title ON todos(lower(title))")


def list_todos(db: LiteWriter, view: TodosView) -> list[Todo]:
    where = "WHERE done = 0" if view.hide_done else ""
    return db.query(f"SELECT id, title, done FROM todos {where} ORDER BY {ORDER[view.sort]}", Todo)
```

The f-strings paste only constants from this file. Every outside value is a `:name` parameter.

```python
# views.py
from dataclasses import replace

from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import page
from app.features.todos.data import Todo
from app.features.todos.urls import ADD_TODO, TODOS, TODOS_LIVE, TOGGLE_TODO, TodosView


def render(todos: list[Todo], view: TodosView, tab: str) -> HtmlElement:
    by_title = replace(view, sort="new" if view.sort == "title" else "title")
    hide_done = replace(view, hide_done=not view.hide_done)
    return page(
        "Todos",
        h.Main(
            {"id": "todos"},
            data.signals({"tab": tab, "title": "", "_error": ""}, if_missing=True),
            data.init(at.get(TODOS_LIVE.href(query=view.query()), retry="always")),
            h.Form(
                data.on("submit", at.post(ADD_TODO.href()), prevent=True),
                data.indicator("_saving"),
                h.Input({"type": "text", "required": True, "maxlength": 200}, data.bind("title")),
                h.Button({"type": "submit"}, data.attr("disabled", "$_saving"), "Add"),
                h.P({"role": "alert"}, data.show("$_error"), data.text("$_error")),
            ),
            h.Nav(
                h.A({"href": TODOS.href(query=by_title.query())}, f"Sort by {by_title.sort}"),
                h.A(
                    {"href": TODOS.href(query=hide_done.query())},
                    "Show done" if view.hide_done else "Hide done",
                ),
            ),
            h.Ul(
                *[
                    h.Li(
                        h.Button(
                            {"type": "button", "aria-pressed": "true" if t.done else "false"},
                            data.on("click", at.post(TOGGLE_TODO.href(t.id))),
                            data.indicator("_saving"),
                            data.attr("disabled", "$_saving"),
                            t.title,
                        )
                    )
                    for t in todos
                ]
            ),
        ),
    )
```

The page `GET` makes a new `tab`. The stream passes the same `tab` back, so the `data-signals` text stays the same in every render. The server renders the `<p role="alert">` empty. Datastar writes `$_error` into it again after each repaint, because `data.text` and `data.show` watch their element.

```python
# handlers.py
import uuid
from dataclasses import dataclass

import apsw
from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals

from app.features.todos.data import add_todo, get_todo, list_todos, toggle_done
from app.features.todos.urls import ADD_TODO, TODOS, TODOS_LIVE, TOGGLE_TODO, TodosView
from app.features.todos.views import render

CHANGED = "todos.changed"


@dataclass(frozen=True, slots=True)
class TodosPage:
    db: LiteWriter
    relay: Relay[dict]

    def register(self, app: App) -> None:
        app.add(TODOS, self.show)
        app.add(TODOS_LIVE, self.live)
        app.add(ADD_TODO, self.add)
        app.add(TOGGLE_TODO, self.toggle)

    async def show(self, c: Context, w: Writer) -> None:
        view = TodosView.from_query(c.req.query)
        w.html(render(list_todos(self.db, view), view, uuid.uuid7().hex))

    async def live(self, c: Context, w: Writer) -> None:
        view = TodosView.from_query(c.req.query)
        tab = str((await read_signals(c.req)).get("tab", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", status=400)
            return
        async with self.relay.subscribe(CHANGED, f"tab.{tab}", latest=True) as events:
            sse = SSE(w)
            sse.patch_elements(render(list_todos(self.db, view), view, tab))
            async for subject, signals in c.alive(events):
                if subject == CHANGED:
                    sse.patch_elements(render(list_todos(self.db, view), view, tab))
                else:
                    sse.patch_signals(signals)

    async def add(self, c: Context, w: Writer) -> None:
        signals = await read_signals(c.req)
        title = str(signals.get("title", "")).strip()
        tab = str(signals.get("tab", ""))
        if not title or len(title) > 200 or not tab.isalnum():
            w.text("title must be 1 to 200 characters", status=400)
            return
        SSE(w).patch_signals({"title": "", "_error": ""})
        try:
            await self.db.write(add_todo, title)
        except apsw.ConstraintError:
            c.span.event("todo.duplicate", {"title": title})
            self.relay.publish(f"tab.{tab}", {"_error": f"“{title}” is already on the list."})
            return
        self.relay.publish(CHANGED, {})

    async def toggle(self, c: Context, w: Writer) -> None:
        todo_id = c.match.params["todo_id"]
        if not todo_id.isdecimal() or get_todo(self.db, int(todo_id)) is None:
            w.text("no such todo", status=404)
            return
        w.empty()
        await self.db.write(toggle_done, int(todo_id))
        self.relay.publish(CHANGED, {})
```

Each command reads, validates, replies, and then executes. `add` replies with `patch_signals` to clear the input and the old error. Then it awaits the write. A duplicate is not an error of the request: the span gets an event, and only this tab gets the `_error` signal.

```python
# app/main.py, inside bootstrap before yield
relay: Relay[dict] = Relay()
TodosPage(db, relay).register(app)
```

One `Relay[dict]` per app, built in `bootstrap`, shared by every page. `CHANGED` carries `{}`. `tab.<id>` carries the signals for that tab.

## Messages to one tab

The signals are the state of one tab. They live in the browser, and a reload starts a new tab with new signals. A command changes them for its own tab through the stream. Choose the signal by what the page shows:

- **A state on the page** (an error under the input, a cleared field, a counter): a page signal such as `_error`, bound with `data.text`, `data.show`, or `data.class_`. Datastar writes the value again after each repaint.
- **A toast** (a job failed, a save went through): the `_toast` signal of the shell. Every page has it:

```python
# app/common/shell.py, the last child of h.Body
h.Output(
    {"id": "toast", "role": "status"},
    data.signals({"_toast": ""}, if_missing=True),
    data.show("$_toast"),
    data.text("$_toast"),
    data.effect("$_toast && setTimeout(() => $_toast = '', 4000)"),
)
```

```python
self.relay.publish(f"tab.{tab}", {"_toast": f"Another todo is called “{title}”."})
```

The effect clears the toast after 4 seconds, so the same text can show again later.

Rules:

- A command sends its tab one publish with every signal it changes. `latest=True` keeps only the newest message for each subject: a newer publish replaces one that the stream has not sent yet.
- A script is for an action with no state (focus an input, scroll to a row): `sse.execute_script("app.list.focus()")`. A value from the server goes in through `string_literal`, which escapes `<` from stario 5.2, so a title cannot end the script tag. Text the user reads goes in a signal.
- A test reads the next stream event: `event["event"] == "datastar-patch-signals"` and the signal name in `event["data"]`.

```python
# tests/test_todos.py
from app.features.todos.urls import ADD_TODO, TODOS, TODOS_LIVE

TAB = {"datastar": '{"tab": "t1"}'}


async def test_add_repaints_the_stream(client):
    async with client.stream("GET", TODOS_LIVE.href(), params=TAB) as live:
        events = live.iter_events()
        assert 'id="todos"' in (await anext(events))["data"]
        r = await client.post(ADD_TODO.href(), json={"title": "milk", "tab": "t1"})
        assert r.status_code == 200
        assert "milk" in (await anext(events))["data"]


async def test_a_duplicate_tells_only_its_own_tab(client):
    await client.post(ADD_TODO.href(), json={"title": "milk", "tab": "t1"})
    async with (
        client.stream("GET", TODOS_LIVE.href(), params=TAB) as mine,
        client.stream("GET", TODOS_LIVE.href(), params={"datastar": '{"tab": "t2"}'}) as other,
    ):
        events, others = mine.iter_events(), other.iter_events()
        await anext(events)
        await anext(others)
        await client.post(ADD_TODO.href(), json={"title": "Milk", "tab": "t1"})
        event = await anext(events)
        assert event["event"] == "datastar-patch-signals"
        assert "already on the list" in event["data"]
        await client.post(ADD_TODO.href(), json={"title": "eggs", "tab": "t2"})
        assert "already" not in (await anext(others))["data"]


async def test_the_view_lives_in_the_url(client):
    for title in ("a", "b"):
        await client.post(ADD_TODO.href(), json={"title": title, "tab": "t1"})
    r = await client.get(TODOS.href(query={"sort": "title"}))
    assert r.text.index(">a<") < r.text.index(">b<")
    r = await client.get(TODOS.href(query={"sort": "nonsense"}))
    assert r.text.index(">b<") < r.text.index(">a<")
```

Open the live stream. Send the command. Assert the next event. That is the proof.

The same page in memory: `data.py` holds a dataclass with the rows and plain functions over it (`list_todos(store, view)`, `add_todo(store, title)`). The handlers are the same. The commands change the object, then publish.

## A page with slow work

The command queues a job and replies at once. A task does the work inside its own span and publishes each status change. The `queued` row is the click feedback.

```python
# data.py
from dataclasses import dataclass, field
from itertools import count


@dataclass(slots=True)
class Job:
    id: int
    status: str = "queued"  # queued | running | done | failed
    result: str = ""


@dataclass(slots=True)
class Jobs:
    rows: dict[int, Job] = field(default_factory=dict)
    ids: count[int] = field(default_factory=lambda: count(1))


def add_job(jobs: Jobs) -> Job:
    job = Job(next(jobs.ids))
    jobs.rows[job.id] = job
    return job


def list_jobs(jobs: Jobs) -> list[Job]:
    return sorted(jobs.rows.values(), key=lambda j: j.id, reverse=True)
```

```python
# handlers.py (the command and the task)
@dataclass(frozen=True, slots=True)
class ReportsPage:
    jobs: Jobs
    relay: Relay[dict]
    delay: float

    async def start(self, c: Context, w: Writer) -> None:
        job = add_job(self.jobs)
        w.empty()
        self.relay.publish(CHANGED, {})
        c.app.create_task(self.run(job, c.span.step("report.run")))

    async def run(self, job: Job, span: Span) -> None:
        with span:
            span.attr("job.id", job.id)
            job.status = "running"
            self.relay.publish(CHANGED, {})
            try:
                await asyncio.sleep(self.delay)
                job.result, job.status = f"Report at {datetime.now(UTC):%H:%M:%S}", "done"
            except Exception as exc:
                job.result, job.status = str(exc), "failed"
                span.exception(exc)
                span.fail(str(exc))
            except asyncio.CancelledError:
                job.result, job.status = "stopped: the server shut down", "failed"
                raise
            finally:
                self.relay.publish(CHANGED, {})
```

- `c.span.step("report.run")` is a child of the request span. The task enters it, so the job has its own duration, events, and error in the trace.
- An error in the work goes to the job row and to the span. Nothing is lost when the request has already ended.
- On shutdown, Stario waits `STARIO_GRACEFUL_SHUTDOWN_TIMEOUT` (5 s), then cancels the task. `CancelledError` marks the job failed and is raised again. A job with several steps passes `c.app` to `run`, checks `app.shutting_down` between the steps, and stops early.
- A job row in SQLite outlives the process. The schema function marks each `queued` or `running` row `failed` when the app starts.
- `delay` is a `Config` field, so a test sets `0`. The test reads stream events until one contains `done`, then `await client.app.drain_tasks()` and `assert client.tracer.find_span("report.run").ok`.

In the view, the button gets `data.indicator("_starting")` and `data.attr("disabled", "$_starting")` while the request is in flight. The new `queued` row takes over after that.

## An edit dialog that survives repaints

One dialog for the whole list. The Edit button fills the field signals and opens it. One route takes the edit. The row id travels as a signal and is validated like any input.

```python
# urls.py
RENAME_TODO = Route("POST /todos/rename")
```

```python
# views.py, inside render: add "editing_id": 0 and "new_title": "" to data.signals
h.Button(
    {"type": "button"},
    data.on(
        "click",
        f"$editing_id = {t.id}; $new_title = {string_literal(t.title)}; $_edit.showModal()",
    ),
    "Rename",
)
h.Dialog(
    data.ref("_edit"),
    data.preserve_attr("open"),
    h.Form(
        data.on("submit", at.post(RENAME_TODO.href()) + "; $_edit.close()", prevent=True),
        data.indicator("_saving"),
        h.Input({"type": "text", "required": True}, data.bind("new_title")),
        h.Button({"type": "submit"}, data.attr("disabled", "$_saving"), "Save"),
    ),
)
```

```python
# handlers.py, a method of TodosPage; register adds app.add(RENAME_TODO, self.rename)
async def rename(self, c: Context, w: Writer) -> None:
    signals = await read_signals(c.req)
    todo_id = signals.get("editing_id")
    title = str(signals.get("new_title", "")).strip()
    tab = str(signals.get("tab", ""))
    if type(todo_id) is not int or get_todo(self.db, todo_id) is None:
        w.text("no such todo", status=404)
        return
    if not title or len(title) > 200 or not tab.isalnum():
        w.text("title must be 1 to 200 characters", status=400)
        return
    w.empty()
    try:
        await self.db.write(set_title, todo_id, title)
    except apsw.ConstraintError:
        self.relay.publish(f"tab.{tab}", {"_toast": f"Another todo is called “{title}”."})
        return
    self.relay.publish(CHANGED, {})
```

`string_literal` comes from `stario.datastar.format`. `data.ref("_edit")` puts the dialog element in the local signal `$_edit`, so no expression looks it up by id. A repaint keeps the dialog open (`preserve_attr`) and keeps what the user typed (`if_missing=True`). `type(...) is not int` also rejects `true`, which `isinstance` accepts. The add form binds its own signal (`title`), not the dialog's `new_title`. `set_title` is `UPDATE todos SET data = json_set(data, '$.title', :title) WHERE id = :id`.

## Check a live update

The stream test is the fast check, and it is the one `just check` runs. Open the live route, read the first event so the subscription is up, send the command, assert the next event. Two streams are two tabs: one post, and both events carry the new HTML. This is the whole check for "the other view never updates". `timeout=2` on `client.stream` makes a missing repaint fail in two seconds. It covers the whole stream, so a job test that waits for `done` sets it above the delay of the job.

```python
# tests/test_todos.py
async def test_add_shows_on_another_tab(client):
    async with (
        client.stream("GET", TODOS_LIVE.href(), params=TAB, timeout=2) as first,
        client.stream("GET", TODOS_LIVE.href(), params=TAB, timeout=2) as second,
    ):
        one, two = first.iter_events(), second.iter_events()
        assert 'id="todos"' in (await anext(one))["data"]
        assert 'id="todos"' in (await anext(two))["data"]
        r = await client.post(ADD_TODO.href(), json={"title": "milk", "tab": "t1"})
        assert r.status_code == 200
        assert "milk" in (await anext(one))["data"]
        assert "milk" in (await anext(two))["data"]
```

### Browser check

Use it only for what `AGENTS.md` (Checks) sends to a browser: client JS that holds state, or a browser bug that no test reproduces. When the user watches the app, the user is the browser; skip this.

The script starts its own server on a free port and stops it in `finally`. It never touches a server it did not start. Keep `playwright` out of the app's dependencies, so `just check` stays fast. Both pages share one browser context, so they share cookies like two tabs.

```python
# scripts/browser.py
import asyncio
import os
import socket
import subprocess
import sys

from playwright.async_api import async_playwright, expect


async def main() -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = os.environ | {"STARIO_PORT": str(port), "PROJECT_DATA_DIR": "/tmp/browser-check"}
    server = subprocess.Popen([sys.executable, "-m", "app.main"], env=env)
    try:
        await asyncio.sleep(1)
        url = f"http://127.0.0.1:{port}/todos"
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            context = await browser.new_context()
            viewer, actor = await context.new_page(), await context.new_page()
            await viewer.goto(url)
            await actor.goto(url)
            await actor.locator("input[type=text]").fill("milk")
            await actor.get_by_role("button", name="Add").click()
            await expect(viewer.get_by_role("button", name="milk")).to_be_visible(timeout=5000)
            await viewer.screenshot(path="/tmp/browser-check/todos.png")
            await browser.close()
    finally:
        server.terminate()
        server.wait(5)


asyncio.run(asyncio.wait_for(main(), 60))
```

```bash
uv run --with playwright playwright install chromium
uv run --with playwright python scripts/browser.py
```

Point the URL and the locators at the page you changed. Wait for a visible result with `expect`, not with a sleep. Keep the script when the app has client JS that holds state; delete it otherwise.

## Remove a page

1. Delete `app/features/<page>/` and `tests/test_<page>.py`.
2. Remove the `register` call and the schema call from `app/main.py`.
3. Fix every import of the deleted `urls.py` or `data.py`; pyright finds them.
4. Tables the page owned: ask the developer whether to drop them.
5. `just check`.

## When the folder grows

A `handlers.py` over about 300 lines or a `views.py` over about 400 lines usually hides a second resource. Split by URL noun, not by layer. Code with no URL moves to `app/<name>/` as plain functions. Do not answer growth with a service class or a command framework.
