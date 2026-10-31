---
name: stario-api
description: The whole Stario API in one page - App, Route, Context (c.req.query, headers, cookies), Writer, Relay, Span, middleware, STARIO_HOST/PORT, h.* tags, TestClient, every data.* attribute, every at.* action, read_signals, SSE, and how a morph treats the page. Use whenever you write handler, view, or test code and are unsure of a name or an argument, and always before you read the stario source in site-packages.
---

# The Stario API

Every signature of stario 5.x, from its source. Do not read `site-packages`: the answer is on this page, and pyright checks each call.

```python
from stario import App, Context, Relay, Route, Span, Writer, classes, h
from stario.cookies import delete_cookie, set_cookie
from stario.http.middleware import catch_errors, same_origin, security_headers
from stario.markup import baked, render
from stario.testing import TestClient
from stario.datastar import SSE, at, data, read_signals
from stario.datastar.format import string_literal  # user text inside an expression
```

# Server side

## App and Route

```text
app.add(ROUTE, handler)                 # one method on one path
app.use("/prefix", middleware)          # middleware is (inner: Handler) -> Handler
app.create_task(coro, name=None)        # tracked; Stario waits for it on shutdown
app.shutting_down                       # True while the server drains

ROUTE = Route("GET /rooms/{room_id}")
ROUTE.href(room_id, query={"sort": "title"}, fragment=None)   # "/rooms/7?sort=title"
```

`python -m app.main` listens on `STARIO_HOST` and `STARIO_PORT` (default `127.0.0.1:8000`).

A literal segment beats a parameter: `/rooms/live` and `/rooms/{room_id}` both work, in any order.

## Context: `c`

```text
c.req.method   c.req.path
c.req.query                    # ParsedQuery: .get(key), .get(key, default), .getlist(key),
                               # .items(), .as_dict(), key in c.req.query
c.req.headers                  # .get(name), .get(name, default), .getlist(name)
c.req.headers.get("datastar-request")   # set on a Datastar action
c.req.cookies                  # .get(name), .get(name, default)
c.match.params                 # path captures: dict of str; validate, then convert
c.state                        # dict that middleware fills: c.state["user"]
c.app                          # the App
c.span                         # this request's span
c.alive(source)                # async iterator until the client leaves or the app drains
c.disconnected  c.shutting_down  c.closing
```

Signals come from `await read_signals(c.req)` (below).

## Writer: `w`

A handler answers once:

```text
w.html(render(...))            # str, bytes, or h.* nodes; status=200
w.text("why", status=400)
w.json(value, status=200)      # through stario.json
w.empty()                      # 204
w.redirect(url, status=307)    # a Datastar request needs SSE(w).navigate(url) instead
w.headers.set(name, value)     # before the answer
set_cookie(w, "sid", token, max_age=None, httponly=True, samesite="lax", secure=False)
delete_cookie(w, "sid")
```

## Relay

```text
relay: Relay[dict] = Relay()                       # one, built in bootstrap
relay.publish("todos.changed", {})                 # dotted subject
async with relay.subscribe("todos.changed", f"tab.{tab}", latest=True) as events:
    async for subject, data in c.alive(events): ...
```

A pattern is an exact subject, `prefix.*`, or `*`. `latest=True` keeps only the newest message per subject. Subscribe before the first render.

## Span

```text
c.span.event("todo.added", {"id": 7})   c.span.attrs({...})   c.span.fail("why")
span = c.span.step("report.run")        # a child span for a job; use it as `with span:`
```

## Middleware

- `same_origin()`: a cross-site `POST` gets 403. Keep it on `/`.
- `security_headers()`: `nosniff`, `x-frame-options: DENY`, and a referrer policy. It sets no Content-Security-Policy, so an inline `<script>` and Datastar expressions work.
- `catch_errors(SomeError, respond=fn)`: turns an exception into a response when nothing was sent.

## HTML: `h.*`

Every HTML tag is `h.` plus the tag name with a capital letter: `h.Div`, `h.Button`, `h.Textarea`, `h.Dialog`. Do not look them up; a tag that does not exist fails at once.

- Attributes come first, children after: `h.A({"href": HOME.href(), "class": "link"}, "Home")`.
- Attribute values: a `str` or a number; `True` writes a bare attribute (`{"disabled": True}`); `None` or `False` leaves it out.
- `classes("btn", {"active": is_on})` builds `class`. `data.*` results go in the same place as a dict.
- A child is a string (escaped), a node, a list of nodes, or `None` (skipped).
- `render(node)` returns the HTML string. `@baked` freezes a page shell; each parameter is a whole child or attribute.
- SVG: `from stario.markup import svg` (`svg.Svg`, `svg.Path`, ...).

## TestClient

```text
async with TestClient(bootstrap, request_timeout=5) as client:
    r = await client.get(url, params={"datastar": '{"tab": "t1"}'})
    r = await client.post(url, json={"title": "milk", "tab": "t1"})
    r.status_code  r.text  r.json()  r.headers  r.cookies
    async with client.stream("GET", url, params=TAB, timeout=2) as live:
        events = live.iter_events()            # dicts with "event" and "data"
        first = await anext(events)
    await client.drain_tasks()                 # wait for create_task work
    client.tracer.find_span("report.run")
```

The client keeps cookies across requests. A `navigate` answer is a 200 event stream that contains `window.location`.

# Page side: Datastar

## Expressions

A `data.*` value is a Datastar expression: JavaScript with a few extras.

- `$title` reads or writes the signal `title`. `$form.title` is a nested signal.
- A leading `_` makes a signal local: `$_open`. Datastar does not send it to the server. It is not a JS global, so page JS cannot read `$_open`.
- `el` is the element. `evt` is the event inside `data.on`.
- `@get(...)`, `@post(...)`: the actions that `at.*` builds. Write them with `at`, not by hand.
- Statements join with `;`. More than two statements: a function in `static/js/` (skill `stario-client`).
- User text inside an expression goes through `string_literal(text)`. Never paste it into the string.

## Attributes: `data.*`

Each method returns attribute text for an `h.*` element: `h.Button(data.on("click", at.post(ADD.href())), "Add")`.

```text
data.signals({...}, if_missing=False)   # patch signals; if_missing=True keeps typed values
data.signal(name, expr, if_missing=False)
data.computed(key, expr)  data.computeds({key: expr})
data.bind(name, prop=None, event=None)   # bind("done", prop="checked", event="change")
data.text(expr)   data.show(expr)   data.effect(expr)
data.attr(key, expr)   data.attrs({key: expr})
data.class_(name, expr)   data.classes({name: expr})
data.style(prop, expr)   data.styles({prop: expr})
data.ref(name)                           # $name is this element
data.indicator(name)                     # $name is true while this element's request runs
data.init(expr, delay=None, view_transition=False)
data.on(event, expr, once=False, passive=False, capture=False, delay=None,
        debounce=None, throttle=None, view_transition=False,
        target=None,                     # "window" | "document" | "outside"
        prevent=False, stop=False, case="kebab")
data.on_intersect(expr, threshold=None, once=False, exit=False, delay=None,
                  debounce=None, throttle=None, view_transition=False)
data.on_interval(expr, duration="1s", leading=False, view_transition=False)
data.on_signal_patch(expr, delay=None, debounce=None, throttle=None,
                     include=None, exclude=None)
data.preserve_attr("open")  data.preserve_attr(["open", "class"])
data.ignore_morph()                      # server patches skip this subtree
data.ignore(self_only=False)             # Datastar skips this subtree
data.json_signals(include=None, exclude=None, terse=False)   # debug view
```

A time is `200`, `0.2`, or `"200ms"`. `debounce` is a time, or `(time, "leading")`. `throttle` is a time, or `(time, "trailing")`. `include` and `exclude` take a regex string or a list of names.

Datastar Pro only. The app ships the free `datastar.js` (v1.0.x), so these do nothing there: `persist`, `query_string`, `replace_url`, `scroll_into_view`, `match_media`, `on_resize`, `on_raf`, `animate`, `custom_validity`, `view_transition`, and the actions `clipboard`, `intl`, `fit`.

## Actions: `at.*`

```text
at.get(url, queries=None, *, content_type=None, include=None, exclude=None,
       selector=None, headers=None, open_when_hidden=None, payload=None,
       retry=None, retry_interval_ms=None, retry_scaler=None,
       retry_max_wait_ms=None, retry_max_count=None, request_cancellation=None)
at.post / at.put / at.patch / at.delete / at.query   # same arguments as at.get
at.peek(expr)   at.set_all(value, include=None, exclude=None)   at.toggle_all(include=None, exclude=None)
```

- `retry`: `"auto"`, `"error"`, `"always"`, `"never"`. A live stream uses `at.get(LIVE.href(), retry="always")`.
- `content_type`: `"json"` (the default, sends the signals) or `"form"`.
- `include` / `exclude` choose which signals go with the request.
- `request_cancellation`: `"auto"` cancels the previous request of the same element.
- Build the URL with `ROUTE.href(...)`. A value that the user picks travels as a signal; the command reads it with `read_signals`.

A request must come from an action. A plain `fetch` ignores the SSE answer, so its `patch_signals` or `navigate` never reach the page.

## Server side: `read_signals` and `SSE`

```text
signals = await read_signals(c.req)      # dict; a GET sends them in ?datastar=
sse = SSE(w)
sse.patch_elements(part, mode=None, selector=None, namespace=None,
                   view_transition=False, view_transition_selector=None)
sse.patch_signals({...}, only_if_missing=False)
sse.navigate(url)                        # a 303 does not change the URL of a Datastar request
sse.execute_script(code, auto_remove=True)   # trusted code only
sse.remove(selector)
sse.ping()                               # keep proxies awake
```

`mode`: `"outer"` (the default), `"inner"`, `"replace"`, `"prepend"`, `"append"`, `"before"`, `"after"`. `namespace`: `"svg"` or `"mathml"`. A file input bound with `data.bind` arrives as a `FileSignal` dict: `name`, `contents` (base64), `mime`.

## How a morph treats the page

- `patch_elements` finds each top element by `id` and morphs it in place. An element with no `id` and no `selector` has no target.
- A morph keeps the element when its tag and `id` stay. Thus `data.init` does not run again on that element. Put work that must follow each repaint in the rendered HTML, not in `data.init`.
- `data.signals(..., if_missing=True)` on the stream element keeps what the user typed through each repaint.
- An open `<dialog>` or `<details>` needs `data.preserve_attr("open")`. A subtree that the client owns needs `data.ignore_morph()`.
- `data.indicator` goes on the element whose `data.on` sends the request: the `<form>` for a submit, not its button.

Trust the morph. When the stream test shows the new HTML in the next event, Datastar puts it on the page.
