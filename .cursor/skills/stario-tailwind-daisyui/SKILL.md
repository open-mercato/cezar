---
name: stario-tailwind-daisyui
description: Style a Stario app with Tailwind CSS v4 and DaisyUI through the standalone tailwindcss binary, with no Node. Use when the user mentions Tailwind, DaisyUI, utility classes, themes, or wants the app to look finished without writing CSS.
---

# Tailwind and DaisyUI without Node

Tailwind compiles `frontend/src/input.css` into `static/css/output.css`. The standalone binary does the work. `npm`, `npx`, and `@tailwindcss/cli` are not used. DaisyUI gives component classes (`btn`, `card`, `modal`, `drawer`) on top of Tailwind, so most pages need no custom CSS.


`h.*` tags, `classes(...)`, `data.*`, and the `STARIO_HOST`/`STARIO_PORT` settings are in skill `stario-api`.
## Install once

```bash
mkdir -p frontend/src static/css
DU=v5.7.50  # pin the DaisyUI tag you tested: https://github.com/saadeghi/daisyui/releases
curl -fL -o frontend/daisyui.mjs "https://github.com/saadeghi/daisyui/releases/download/$DU/daisyui.mjs"
curl -fL -o frontend/daisyui-theme.mjs "https://github.com/saadeghi/daisyui/releases/download/$DU/daisyui-theme.mjs"
```

The `tailwind` recipe in the `justfile` gets the Tailwind binary (see Build). Add `tailwindcss` to `.gitignore`. Commit the two `.mjs` files and `static/css/output.css`.

## `frontend/src/input.css`

```css
@import "tailwindcss";

@source not "../../tailwindcss";
@source not "../daisyui{,*}.mjs";
@source "../../app/**/*.py";

@plugin "../daisyui.mjs" {
  themes: light --default, dark --prefersdark;
}
```

`@source "../../app/**/*.py"` tells Tailwind to scan the Python views for class names. A class that is not written as a literal in a `.py` file is not generated. Build class lists with `classes("btn", "btn-primary")`, not with string concatenation.

A custom theme:

```css
@plugin "../daisyui.mjs" {
  themes: false;
}

@plugin "../daisyui-theme.mjs" {
  name: "app";
  default: true;
  color-scheme: light;
  --color-base-100: #f7f6f1;
  --color-base-content: #1a1f24;
  --color-primary: #3d4a6b;
  --color-primary-content: #f7f6f1;
}
```

## Build

Add three recipes to the `justfile`. `v` pins the Tailwind tag, so every machine builds the same CSS. `just css` gets the binary when `./tailwindcss` is missing. Each version downloads once per machine into `~/.cache/tailwindcss/`.

```make
# get the pinned Tailwind CLI; css and css-watch run this first
tailwind:
    #!/usr/bin/env sh
    set -eu
    v=v4.3.3
    bin="$HOME/.cache/tailwindcss/$v/tailwindcss"
    if [ "$(readlink tailwindcss 2>/dev/null)" = "$bin" ] && [ -x "$bin" ]; then exit 0; fi
    case "$(uname -s):$(uname -m)" in
      Darwin:arm64) a=macos-arm64 ;;
      Darwin:x86_64) a=macos-x64 ;;
      Linux:x86_64 | Linux:amd64) a=linux-x64 ;;
      Linux:aarch64 | Linux:arm64) a=linux-arm64 ;;
      *) echo "no Tailwind build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
    esac
    if [ ! -x "$bin" ]; then
      mkdir -p "$(dirname "$bin")"
      curl -fL --retry 3 -o "$bin.part" "https://github.com/tailwindlabs/tailwindcss/releases/download/$v/tailwindcss-$a"
      chmod +x "$bin.part"
      mv "$bin.part" "$bin"
    fi
    ln -sfn "$bin" tailwindcss

# build the stylesheet once
css: tailwind
    ./tailwindcss -i frontend/src/input.css -o static/css/output.css --minify

# rebuild the stylesheet on change; run next to `just dev`
css-watch: tailwind
    ./tailwindcss -i frontend/src/input.css -o static/css/output.css --watch
```

Run `just css-watch` next to `just dev`, and `just css` before a commit. `Assets` fingerprints `output.css`, so `STYLE_CSS = ASSETS.href("css/output.css")` in `app/assets.py`.

## The shell

```python
from stario import h
from stario.datastar import ModuleScript, data
from stario.markup import HtmlElement, baked, classes

from app.assets import DATASTAR_JS, SCRIPTS, STYLE_CSS


@baked
def page(title: str, body: HtmlElement) -> HtmlElement:
    return h.HtmlDocument(
        {"lang": "en", "data-theme": "light"},
        data.preserve_attr("data-theme"),
        h.Head(
            h.Meta({"charset": "utf-8"}),
            h.Meta({"name": "viewport", "content": "width=device-width, initial-scale=1"}),
            h.Title(title),
            h.Link({"rel": "stylesheet", "href": STYLE_CSS}),
            *[h.Script({"src": src, "defer": True}) for src in SCRIPTS],
            ModuleScript(DATASTAR_JS),
        ),
        h.Body(
            classes("min-h-screen", "bg-base-100", "text-base-content"),
            body,
            h.Div(
                classes("toast", "toast-end"),
                data.show("$_toast"),
                h.Output(
                    classes("alert", "alert-info"),
                    {"role": "status"},
                    data.signals({"_toast": ""}, if_missing=True),
                    data.text("$_toast"),
                    data.effect("$_toast && setTimeout(() => $_toast = '', 4000)"),
                ),
            ),
        ),
    )
```

`data-theme` on `<html>` selects the DaisyUI theme. `data-preserve-attr="data-theme"` keeps a theme the user switched when the stream morphs the document.

## A theme switch

The theme is client-only state. The browser keeps it in `localStorage`; the server does not store it.

Add one line to `input.css`, so `dark:` utilities follow `data-theme` and not the OS setting:

```css
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

In the shell, restore the theme in `<head>`, before the first paint. A restore in `data.init` runs after Datastar loads, and a dark page flashes light first. This one line is the only inline script in the app.

```python
from stario.markup import SafeString

RESTORE_THEME = SafeString(
    "document.documentElement.dataset.theme = localStorage.getItem('theme')"
    " || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')"
)

# in page(): h.Head(..., h.Script(RESTORE_THEME), ...)
h.Button(
    classes("btn", "btn-ghost", "btn-circle"),
    {"type": "button", "aria-label": "Switch theme"},
    data.on("click", "app.theme.toggle()"),
    h.Span(classes("dark:hidden"), "Dark"),
    h.Span(classes("hidden", "dark:inline"), "Light"),
)
```

The toggle lives in `static/js/theme.js` (skill `stario-client`), listed in `SCRIPTS` in `app/assets.py`:

```js
window.app ??= {};
app.theme = {
  toggle() {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", root.dataset.theme);
  },
};
```

The labels follow `dark:` utilities, so no script updates them. `data.preserve_attr("data-theme")` on `<html>` keeps the choice when the stream morphs the document.

## Classes in views

```python
h.Button(classes("btn", "btn-primary"), data.on("click", at.post(SAVE.href())), "Save")
h.Input(classes("input", "input-bordered", "w-full"), {"type": "text"}, data.bind("title"))
h.Div(classes("card", "bg-base-200", "shadow"), h.Div(classes("card-body"), ...))
```

Rules:

- DaisyUI component class first, Tailwind utilities after. `btn btn-primary w-full`.
- Theme colors only: `bg-base-100`, `bg-base-200`, `text-base-content`, `bg-primary`, `text-primary-content`. No raw `bg-gray-100`. The theme stays switchable.
- Layout with `flex`, `grid`, `gap-*`, `p-*`. No custom CSS for layout.
- Custom CSS goes into `input.css` under `@layer components` only when a DaisyUI class does not exist. Name it after the app: `.app-stage`.
- Tailwind scans only `app/**/*.py`. A class that only a `static/js/` file adds needs `@source "../../static/js/*.js";` in `input.css`. Better: let the HTML hold the class and toggle it with `data.class_`.
- A modal is `<dialog class="modal">` with `data.preserve_attr("open")`. The server never renders it open.
- A drawer on wide screens: `drawer lg:drawer-open`. The toggle is a checkbox the client owns; add `data.ignore_morph()` to the checkbox or `data.preserve_attr("checked")`.

## Checks

After you change a class, run `just css` and commit `static/css/output.css`. `just css` gets the binary on any machine, a Cloud Agent included.

The page loads a stylesheet: `assert 'css/output' in r.text` in the page test. Prove the link with `TestClient`. When a class does not apply in the browser, check that the literal appears in a `.py` file under `app/`, then rebuild. A live morph uses the Playwright script in `stario-feature`. Computer use is for whether the theme looks right.
