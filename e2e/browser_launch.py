"""Start Chromium for the walks, falling back to a preinstalled build.

Playwright pins one Chromium build. A machine that preinstalled a nearby build (a container
image, a CI cache) has the browser but not the pinned revision, so the default launch fails.
Then this takes `chromium-*/chrome-linux64/chrome` under `PLAYWRIGHT_BROWSERS_PATH`, or
`/opt/pw-browsers`, and never downloads anything.
"""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import Browser, Error, Playwright


def launch_chromium(playwright: Playwright) -> Browser:
    try:
        return playwright.chromium.launch(headless=True)
    except Error:
        roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""), "/opt/pw-browsers"]
        for root in filter(None, roots):
            found = sorted(Path(root).glob("chromium-*/chrome-linux64/chrome"))
            if found:
                return playwright.chromium.launch(headless=True, executable_path=str(found[-1]))
        raise
