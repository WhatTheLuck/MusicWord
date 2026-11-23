"""Embed the common audition player and its local assets in offline reports."""

import json
from pathlib import Path


PREVIEW_ASSETS = Path(__file__).with_name("web") / "public" / "music-preview"


def preview_html():
    player = (PREVIEW_ASSETS / "preview.js").read_text(encoding="utf-8")
    assets = {
        path.relative_to(PREVIEW_ASSETS).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(PREVIEW_ASSETS.rglob("*.js")) if path.name != "preview.js"
    }
    encoded = json.dumps(assets, separators=(",", ":")).replace("<", "\\u003c")
    licenses = "\n\n".join(path.read_text(encoding="utf-8") for path in sorted(PREVIEW_ASSETS.glob("LICENSE-*.md")))
    return (f'<!--\n{licenses.replace("--", "—")}\n-->\n'
            f'<script id="musicword-preview-assets" type="application/json">{encoded}</script>\n'
            f"<script>{player}</script>")
