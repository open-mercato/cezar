---
name: stario-auth
description: User identity in a Stario app - a signed session cookie, middleware that puts the user on c.state, a login page, logout, and protected pages. Use when the user asks for login, sign in, accounts, sessions, "who is the user", or wants a page only some users can open.
---

# Sessions and login

Read `AGENTS.md` first. This skill adds one shared module, one page, and one rule: user identity lives in a signed cookie, never in a signal or a URL. The users table is in SQLite through litewriter (skill `stario-litewriter`).

Stario ships `set_cookie` and `delete_cookie` in `stario.cookies`, `same_origin()` in `stario.http` (the scaffold already applies it), and a per-request `c.state` dict. It ships no session or user store. The code below is the whole default. Copy it; do not import a session library.

## `app/common/session.py`

One frozen dataclass. It signs, verifies, issues, and clears the cookie, and it gives two middlewares.

```python
import base64
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass

from stario import Context, Handler, Middleware, Writer
from stario.cookies import delete_cookie, set_cookie
from stario.datastar import SSE


@dataclass(frozen=True, slots=True)
class Session:
    secret: bytes
    cookie: str = "session"
    max_age: int = 60 * 60 * 24 * 14
    secure: bool = True

    def sign(self, body: str) -> str:
        digest = hmac.new(self.secret, body.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode()

    def issue(self, w: Writer, user_id: str) -> None:
        body = f"{user_id}.{int(time.time()) + self.max_age}"
        set_cookie(
            w,
            self.cookie,
            f"{body}.{self.sign(body)}",
            max_age=self.max_age,
            httponly=True,
            secure=self.secure,
            samesite="lax",
        )

    def clear(self, w: Writer) -> None:
        delete_cookie(w, self.cookie, httponly=True, secure=self.secure, samesite="lax")

    def user_id(self, c: Context) -> str | None:
        body, _, sig = c.req.cookies.get(self.cookie, "").rpartition(".")
        user_id, _, exp = body.rpartition(".")
        if not user_id or not exp.isdecimal() or int(exp) < time.time():
            return None
        return user_id if hmac.compare_digest(self.sign(body), sig) else None

    def attach(self) -> Middleware:
        """Every request gets c.state["user"]: the user id or None."""

        def middleware(inner: Handler) -> Handler:
            async def handler(c: Context, w: Writer) -> None:
                c.state["user"] = self.user_id(c)
                await inner(c, w)

            return handler

        return middleware

    def require(self, login_url: str) -> Middleware:
        """A page for signed-in users. A page load redirects. A Datastar action navigates."""

        def middleware(inner: Handler) -> Handler:
            async def handler(c: Context, w: Writer) -> None:
                if c.state.get("user") is None:
                    if c.req.headers.get("datastar-request"):
                        SSE(w).navigate(login_url)
                    else:
                        w.redirect(login_url, status=303)
                    return
                await inner(c, w)

            return handler

        return middleware


def hash_password(password: str, salt: bytes | None = None) -> str:
    """About 30 ms of CPU. Call it through asyncio.to_thread from a handler."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def check_password(password: str, stored: str) -> bool:
    salt_b64, _, _ = stored.partition("$")
    return hmac.compare_digest(hash_password(password, base64.b64decode(salt_b64)), stored)
```

`c.state["user"]` is the user id as a string. A handler that needs more reads the user row with that id.

scrypt takes about 30 ms of CPU. On the loop, every other request waits for it. Thus a handler calls `await asyncio.to_thread(check_password, ...)`. `to_thread` uses the loop's thread pool, so a call costs about 20 µs more than a direct call.

## `Config`

```python
@dataclass(frozen=True, slots=True)
class Config:
    app_name: str
    data_dir: Path
    db_path: Path
    session_secret: bytes
    dev: bool
    admin_email: str
    admin_password: str

    @classmethod
    def from_env(cls) -> Config:
        secret = os.environ.get("SESSION_SECRET", "")
        if len(secret) < 32:
            raise RuntimeError("Set SESSION_SECRET to 32+ random characters.")
        admin_email = os.environ.get("ADMIN_EMAIL", "")
        admin_password = os.environ.get("ADMIN_PASSWORD", "")
        if admin_email and len(admin_password) < 12:
            raise RuntimeError("ADMIN_EMAIL is set: set ADMIN_PASSWORD to 12+ characters.")
        data_dir = Path(os.environ.get("PROJECT_DATA_DIR", "data"))
        data_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            app_name=os.environ.get("APP_NAME", "app"),
            data_dir=data_dir,
            db_path=data_dir / "app.sqlite3",
            session_secret=secret.encode(),
            dev=os.environ.get("APP_DEV") == "1",
            admin_email=admin_email,
            admin_password=admin_password,
        )
```

The first three fields are the scaffold's; keep them. Generate a secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`. `APP_DEV=1` allows the cookie over plain HTTP on localhost. Do not set it in production. The app does not start with an admin email and no password, so no admin account has an empty password.

## The users table: `app/features/login/data.py`

```python
from litewriter import LiteWriter, Tx
from stario.json import dumps


def schema(tx: Tx) -> None:
    tx.execute(
        "CREATE TABLE IF NOT EXISTS users ("
        " id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK (json_valid(data)),"
        " email TEXT AS (data->>'email') VIRTUAL)"
    )
    tx.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email)")


def get_login(db: LiteWriter, email: str) -> tuple[str, str] | None:
    return db.one("SELECT id, data->>'password' FROM users WHERE email = :email", email=email)


def count_users(db: LiteWriter) -> int:
    return db.value("SELECT count(*) FROM users")


def add_user(tx: Tx, user_id: str, email: str, password_hash: str) -> None:
    tx.execute(
        "INSERT INTO users (id, data) VALUES (:id, :data)",
        id=user_id,
        data=dumps({"email": email, "password": password_hash}),
    )
```

Hash the password before `db.write`, never inside the write function: the hash would hold the writer's whole batch. A sign-up with a taken email raises `apsw.ConstraintError` from `db.write`. Catch it and send "That email is already registered." to the tab.

## Wire it in `bootstrap`

```python
async def bootstrap(app: App, span: Span):
    config = Config.from_env()
    async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
        if config.admin_email and login_data.count_users(db) == 0:
            password_hash = await asyncio.to_thread(hash_password, config.admin_password)
            await db.write(
                login_data.add_user, str(uuid.uuid7()), config.admin_email, password_hash
            )
        session = Session(config.session_secret, secure=not config.dev)
        app.use("/", same_origin(), security_headers(), session.attach())
        app.use("/app", session.require(LOGIN.href()))
        span.attrs(await ASSETS.attach(app))
        LoginPage(db, session).register(app)
        BoardPage(db, Relay[dict]()).register(app)  # BOARD = Route("GET /app/board")
        yield
```

- Protected pages share one URL prefix, `/app`. Public pages (`/`, `/login`) stay outside it. One `app.use` protects the prefix, including its 404 and 405 answers.
- `same_origin()` must stay before the session middleware. It answers 403 to a `POST`, `PUT`, `PATCH`, or `DELETE` that another site sent. With the `samesite="lax"` cookie, no other page can forge a command.
- `app.use("/", ...)` runs before every route, so `c.state["user"]` is always set.
- One protected page outside the prefix passes `middleware=[session.require(LOGIN.href())]` to `app.add`.

### Accounts in an app that already has pages

- Keep the URLs. Links and bookmarks point at them. Protect a page where it is: `app.use("/todos", session.require(LOGIN.href()))` covers `/todos` and every route below it. Use the `/app` prefix only for new apps.
- Ask the developer what happens to rows that exist before accounts: give them to the seed user, or delete them. If you cannot ask, keep the rows and write the open choice in `## This app`.
- A table whose rows belong to a user gets a real `user_id` column with an index. Every read, stream, and command filters by `c.state["user"]`. A command checks that the row belongs to the user before it changes it (404 when it does not).

## The login page: `app/features/login/`

Login is a static page. Its submit is a command with no stream. Checking the password is a read, so it is part of validation. The reply is the cookie and `navigate`, or the error in a signal. The reply is never HTML.

```python
# urls.py
from stario import Route

LOGIN = Route("GET /login")
LOGIN_POST = Route("POST /login")
LOGOUT = Route("POST /logout")
```

```python
# views.py
from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import page
from app.features.login.urls import LOGIN_POST


def render() -> HtmlElement:
    return page(
        "Sign in",
        h.Main(
            {"id": "login"},
            data.signals({"email": "", "password": "", "_error": ""}, if_missing=True),
            h.Form(
                data.on("submit", at.post(LOGIN_POST.href()), prevent=True),
                h.Label(
                    "Email",
                    h.Input(
                        {"type": "email", "required": True, "autocomplete": "username"},
                        data.bind("email"),
                    ),
                ),
                h.Label(
                    "Password",
                    h.Input(
                        {"type": "password", "required": True, "autocomplete": "current-password"},
                        data.bind("password"),
                    ),
                ),
                h.P({"role": "alert"}, data.show("$_error"), data.text("$_error")),
                h.Button({"type": "submit"}, "Sign in"),
            ),
        ),
    )
```

```python
# handlers.py
import asyncio
from dataclasses import dataclass

from litewriter import LiteWriter
from stario import App, Context, Writer
from stario.datastar import SSE, read_signals

from app.common.session import Session, check_password
from app.features.home.urls import HOME
from app.features.login.data import get_login
from app.features.login.urls import LOGIN, LOGIN_POST, LOGOUT
from app.features.login.views import render


@dataclass(frozen=True, slots=True)
class LoginPage:
    db: LiteWriter
    session: Session

    def register(self, app: App) -> None:
        app.add(LOGIN, self.show)
        app.add(LOGIN_POST, self.submit)
        app.add(LOGOUT, self.logout)

    async def show(self, c: Context, w: Writer) -> None:
        if c.state.get("user"):
            w.redirect(HOME.href(), status=303)
            return
        w.html(render())

    async def submit(self, c: Context, w: Writer) -> None:
        signals = await read_signals(c.req)
        email = str(signals.get("email", "")).strip().lower()
        password = str(signals.get("password", ""))
        login = get_login(self.db, email)
        if login is None or not await asyncio.to_thread(check_password, password, login[1]):
            SSE(w).patch_signals({"password": "", "_error": "Wrong email or password."})
            return
        self.session.issue(w, login[0])
        SSE(w).navigate(HOME.href())

    async def logout(self, c: Context, w: Writer) -> None:
        self.session.clear(w)
        SSE(w).navigate(LOGIN.href())
```

`Set-Cookie` goes out with the first write, so `issue` and `clear` come before `navigate`. A sign-up page has the same shape: validate, `hash_password` in `to_thread`, `await db.write(add_user, str(uuid.uuid7()), email, password_hash)`, issue, navigate.

A logout button on any page: `h.Button({"type": "button"}, data.on("click", at.post(LOGOUT.href())), "Sign out")`.

## Tests

Prove login with `TestClient`. Do not open a browser for a sign-in or a redirect.

```python
# tests/conftest.py
import pytest
from stario.testing import TestClient

from app.features.login.urls import LOGIN_POST
from app.main import bootstrap


@pytest.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SESSION_SECRET", "test-secret-test-secret-test-secret-test")
    monkeypatch.setenv("APP_DEV", "1")
    monkeypatch.setenv("ADMIN_EMAIL", "ada@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "correct-horse")
    async with TestClient(bootstrap, request_timeout=5) as c:
        yield c


async def login(client, email="ada@example.com", password="correct-horse") -> None:
    r = await client.post(LOGIN_POST.href(), json={"email": email, "password": password})
    assert "window.location" in r.text
```

```python
# tests/test_login.py
from app.features.board.urls import BOARD
from app.features.login.urls import LOGIN, LOGIN_POST, LOGOUT
from tests.conftest import login


async def test_protected_page_redirects_to_login(client):
    r = await client.get(BOARD.href(), follow_redirects=False)
    assert r.status_code == 303
    assert r.headers.get("location") == LOGIN.href()


async def test_wrong_password_sets_the_error_signal(client):
    r = await client.post(LOGIN_POST.href(), json={"email": "ada@example.com", "password": "no"})
    assert "Wrong email or password" in r.text
    assert "window.location" not in r.text


async def test_login_then_logout(client):
    await login(client)
    assert (await client.get(BOARD.href())).status_code == 200
    await client.post(LOGOUT.href())
    assert (await client.get(BOARD.href(), follow_redirects=False)).status_code == 303
```

`TestClient` keeps a cookie jar, so `login` makes the next `GET` signed in. A stream under `/app` that is opened signed out replies `navigate`, not `303`: send `headers={"datastar-request": "true"}` and assert `"window.location" in r.text`.

## Rules

- The cookie holds the user id and an expiry, signed. It holds no password, no role, no row.
- `httponly=True` always. `secure=True` outside local development. `samesite="lax"`.
- Passwords are hashed with `scrypt` in `asyncio.to_thread`. Never stored in clear, logged, or put in a span attribute.
- A protected page uses `require`. A handler never checks the cookie itself.
- A command that acts for a user reads `c.state["user"]`, not a signal or a path parameter.
- Logout is a `POST`. A `GET` that changes state is a bug.
- A session lasts `max_age` and cannot be revoked one at a time. When the app needs "sign out everywhere", add a `session_version` to the user `data` and to the cookie body, and compare them in `user_id`.
