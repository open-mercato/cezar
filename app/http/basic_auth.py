"""HTTP Basic auth for a hosted cockpit.

The TypeScript server has no login. Its VPS install puts Basic auth on nginx,
and the docs say a published port with no proxy is an open agent. Compose
publishes the port and binds `0.0.0.0`, which is hosted mode, so this process
issues the challenge itself. A loopback bind with `CEZ_REMOTE` unset does not:
that is the local cockpit, and it stays open the way `cezar serve` does.

`GET /health` stays open so the compose healthcheck does not carry a secret.
"""

from __future__ import annotations

import base64
import hmac
import secrets
import sys
from pathlib import Path

from stario.cookies import set_cookie
from stario.http.context import Context, Handler, Middleware
from stario.http.writer import Writer

from app.config import Config, auth_password, auth_user
from app.http.loopback import hosted_mode

_REALM = 'Basic realm="cezar"'
_COOKIE = "cezar_session"


def basic_auth(config: Config) -> Middleware:
    if not hosted_mode(config):

        def open_middleware(handler: Handler) -> Handler:
            return handler

        return open_middleware

    user, password = _credentials(config)
    token = _session_token(config)

    def middleware(handler: Handler) -> Handler:
        async def wrapped(c: Context, w: Writer) -> None:
            if c.req.path == "/health":
                await handler(c, w)
                return
            if _accepts(c.req.headers.get("authorization"), user, password):
                set_cookie(
                    w,
                    _COOKIE,
                    token,
                    httponly=True,
                    samesite="lax",
                    secure=_https(c),
                )
                await handler(c, w)
                return
            presented = c.req.cookies.get(_COOKIE, "")
            if presented and hmac.compare_digest(presented, token):
                await handler(c, w)
                return
            w.headers.set("www-authenticate", _REALM)
            w.json({"error": "authentication required"}, status=401)

        return wrapped

    return middleware


def _session_token(config: Config) -> str:
    path = Path(config.data_dir) / "session-token"
    if path.is_file():
        stored = path.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    token = secrets.token_urlsafe(24)
    path.write_text(token + "\n", encoding="utf-8")
    path.chmod(0o600)
    return token


def _credentials(config: Config) -> tuple[str, str]:
    user = auth_user()
    chosen = auth_password()
    if chosen:
        return user, chosen
    path = Path(config.data_dir) / "auth-password"
    if path.is_file():
        stored = path.read_text(encoding="utf-8").strip()
        if stored:
            return user, stored
    generated = secrets.token_urlsafe(18)
    path.write_text(generated + "\n", encoding="utf-8")
    path.chmod(0o600)
    print(
        f"Hosted cockpit login: {user} / {generated} (saved in {path})",
        file=sys.stderr,
    )
    return user, generated


def _https(c: Context) -> bool:
    """Secure when a proxy says the browser used https. A plain loopback cockpit stays unset."""
    forwarded = c.req.headers.get("x-forwarded-proto", "")
    return forwarded.split(",")[0].strip().lower() == "https"


def _accepts(header: str | None, user: str, password: str) -> bool:
    if not header:
        return False
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "basic" or not token:
        return False
    try:
        decoded = base64.b64decode(token, validate=True).decode("utf-8")
    except ValueError, UnicodeDecodeError:
        return False
    given_user, sep, given_password = decoded.partition(":")
    if not sep:
        return False
    return hmac.compare_digest(given_user, user) and hmac.compare_digest(given_password, password)
