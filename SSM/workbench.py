"""Local SSM web server and standalone analysis export."""
import argparse
import base64
from datetime import datetime, timezone
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from math import lcm
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

import numpy as np

from midi_data import read_midi_as_track_dfs
from ssm import PARENT_EDGE_TOLERANCE_BEATS, SPLIT_MIN_BEATS, MatrixSizeError, run_singletrack_ssm_pipeline

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"

# Use the same player bundle for SSM and ActiveBasis offline reports.
sys.path.append(str(ROOT.parent / "ActiveBasis"))
from preview_assets import PREVIEW_ASSETS, preview_html

PRESET_DIR = ROOT / "parameter_presets"
CLASSICAL_ROOT = ROOT.parent / "midi-presets" / "classical"
CLASSICAL_MANIFEST = CLASSICAL_ROOT / "index.json"
CLASSICAL = json.loads(CLASSICAL_MANIFEST.read_text(encoding="utf-8")) if CLASSICAL_MANIFEST.is_file() else []
EXAMPLES = {
    "elise": (ROOT / "examples" / "Fr_Elise.mid", "贝多芬 · 致爱丽丝"),
    "bach": (ROOT / "examples" / "Prelude_and_Fugue_in_E_major_BWV854.mid", "巴赫 · E 大调前奏曲与赋格 BWV 854"),
}
EXAMPLES.update({song["id"]: (CLASSICAL_ROOT / song["file"], song["name"]) for song in CLASSICAL})
DEFAULTS = {
    "track": 0, "mode": "NCC", "tpb": 12, "stride": 1.0, "threshold": 0.45,
    "splitOverlaps": True, "minBeats": 4, "blurSize": 4, "blurSigma": 1.0, "sadSigma": 1.0,
    "splitMinBeats": SPLIT_MIN_BEATS,
    "parentEdgeTolerance": PARENT_EDGE_TOLERANCE_BEATS,
    "onsetWeight": 1.0, "durationWeight": 0.2, "uniqueMinBeats": 4, "fillMinBeats": 0,
    "rectangleMinBeats": 2.0, "removeSelfSimilarity": True,
}
LIMITS = {
    "track": (0, 4096), "tpb": (1, 96), "stride": (0.01, 16.0),
    "threshold": (0.0, 1.0), "minBeats": (1, 10),
    "splitMinBeats": (0.0, 10.0),
    "parentEdgeTolerance": (0.0, 32768.0),
    "blurSize": (1, 15), "blurSigma": (0.1, 16.0), "sadSigma": (0.01, 32.0),
    "onsetWeight": (0.01, 4.0), "durationWeight": (0.0, 4.0),
    "uniqueMinBeats": (1, 10), "fillMinBeats": (0, 10),
    "rectangleMinBeats": (0.0, 32768.0),
}
BOOLEAN_LABELS = {"splitOverlaps": "截断交叠", "removeSelfSimilarity": "去除自相似"}
MAX_FILE_BYTES = 2 * 1024 * 1024
STRIDE_STOPS = tuple(2.0 ** exponent for exponent in range(-5, 4))
MAX_FRAMES = 2048
MAX_ROLL_CELLS = 8_000_000
ANALYSIS_SLOT = threading.Semaphore(1)


def config_from(values):
    config = dict(DEFAULTS)
    for key, raw in values.items():
        if key == "mode":
            if raw not in {"NCC", "SAD", "TEXTON"}:
                raise ValueError("请选择有效的相似度算法。")
            config[key] = raw
        elif key in BOOLEAN_LABELS:
            if isinstance(raw, bool):
                config[key] = raw
            elif raw in ("0", "1"):
                config[key] = raw == "1"
            else:
                raise ValueError(f"{BOOLEAN_LABELS[key]}参数必须为 0 或 1。")
        elif key in LIMITS:
            try:
                value = type(DEFAULTS[key])(raw)
            except (TypeError, ValueError):
                raise ValueError(f"参数 {key} 的格式无效。") from None
            low, high = LIMITS[key]
            if not low <= value <= high:
                raise ValueError(f"参数 {key} 必须在 {low} 到 {high} 之间。")
            config[key] = value
    if config["mode"] == "TEXTON":
        config["stride"] = 1.0
    return config


def preset_settings(values):
    if not isinstance(values, dict) or not all(
        type(value) in (str, int, float, bool) for value in values.values()
    ):
        raise ValueError("参数方案格式无效。")
    config = config_from({
        key: str(value) if key in LIMITS else value
        for key, value in values.items() if key in DEFAULTS and key != "track"
    })
    config.pop("track")
    pad_tree_parents = values.get("padTreeParents", True)
    if not isinstance(pad_tree_parents, bool):
        raise ValueError("补充父节点参数必须为布尔值。")
    config["padTreeParents"] = pad_tree_parents
    return config


def list_presets():
    presets = []
    for path in sorted(PRESET_DIR.glob("ssm-*.json"), reverse=True):
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            datetime.fromisoformat(saved["savedAt"])
            settings = preset_settings(saved["settings"])
        except (OSError, ValueError, TypeError, KeyError, OverflowError):
            continue
        presets.append({"id": path.stem, "savedAt": saved["savedAt"], "settings": settings})
    return presets


def save_preset(values):
    settings = preset_settings(values)
    now = datetime.now(timezone.utc)
    preset_id = f"ssm-{now:%Y%m%dT%H%M%S%fZ}-{uuid4().hex[:8]}"
    saved = {"savedAt": now.isoformat(), "settings": settings}
    PRESET_DIR.mkdir(exist_ok=True)
    file = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=PRESET_DIR, delete=False)
    temporary = Path(file.name)
    try:
        with file:
            json.dump(saved, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write("\n")
        temporary.replace(PRESET_DIR / f"{preset_id}.json")
    finally:
        temporary.unlink(missing_ok=True)
    return {"id": preset_id, **saved}


def track_meta(meta):
    return meta["instruments"]


def matrix_bytes(matrix):
    return base64.b64encode(np.ascontiguousarray(matrix, dtype="<f4")).decode("ascii")


def analysis_tpb(tpb, stride):
    if stride in STRIDE_STOPS:
        # Preserve the requested quantization grid and make the step exact.
        return lcm(tpb, stride.as_integer_ratio()[1])
    return tpb


def matrix_size_error(error, config):
    message = str(error)
    if config["mode"] != "TEXTON":
        requested = config["stride"]
        old_tpb = analysis_tpb(config["tpb"], requested)
        for stride in STRIDE_STOPS:
            if stride <= requested:
                continue
            tpb = analysis_tpb(config["tpb"], stride)
            # The latest unrounded note end was at most half a tick later.
            ticks = round((error.ticks - 0.5) * tpb / old_tpb) + 1
            if 0 < ticks // round(stride * tpb) <= MAX_FRAMES and ticks * error.pitches <= MAX_ROLL_CELLS:
                return {"error": message, "suggestedStride": stride}
    return {"error": message + "请选择较短的音轨。"}


def analyze(path, name, config, annotation_range=None):
    start = time.perf_counter()
    tpb = analysis_tpb(config["tpb"], config["stride"])
    result = run_singletrack_ssm_pipeline(
        midi_path=path, track_idx=config["track"], tpb=tpb,
        ssm_mode=config["mode"], ssm_beat_stride=config["stride"],
        filter_thr=config["threshold"], min_line_beat_len=config["minBeats"],
        split_overlaps=config["splitOverlaps"], split_min_beats=config.get("splitMinBeats", SPLIT_MIN_BEATS),
        blur_size=config["blurSize"], blur_sigma=config["blurSigma"], sigma=config["sadSigma"],
        note_on_weight=config["onsetWeight"], dur_weight=config["durationWeight"],
        max_frames=MAX_FRAMES, max_roll_cells=MAX_ROLL_CELLS,
        include_raw_lines=False, include_short_lines=True, copy_leaf_matrices=False,
        rectangle_min_beats=config["rectangleMinBeats"],
        remove_self_similarity=config["removeSelfSimilarity"],
        unique_min_len_tick=config["uniqueMinBeats"] * tpb,
        fill_min_len_tick=config["fillMinBeats"] * tpb,
        parent_edge_tolerance_beats=config["parentEdgeTolerance"],
        annotation_range=annotation_range,
    )
    pr, matrix = result["pr"], result["ssm_raw"]
    lines = result["diag_lines_filtered"]
    root = result["tree_root"]
    nodes = []
    stack = [(root, None, 0)]
    while stack:
        node, parent, depth = stack.pop()
        index = len(nodes)
        nodes.append({"start": node.start, "end": node.end, "class": node.shape_class,
                      "parent": parent, "depth": depth})
        if hasattr(node, "match_bounds"):
            nodes[-1]["matchBounds"] = node.match_bounds
        stack.extend((child, index, depth + 1) for child in reversed(node.children))

    meta = result["meta"]
    tempos = []
    beat = 0.0
    previous_time = 0.0
    previous_bpm = float(meta["bpm"])
    for second, bpm in zip(meta["tempo_times"], meta["tempi"]):
        beat += (float(second) - previous_time) * previous_bpm / 60
        tempos.append([beat, float(second), float(bpm)])
        previous_time, previous_bpm = float(second), float(bpm)

    return {
        "version": 2, "name": name, "config": config, "tracks": track_meta(meta),
        "bpm": meta["bpm"], "tempos": tempos, "tpb": tpb, "stride": result["stride_tick"],
        "ticks": pr.shape[1], "pitchStart": result["pitch_start"], "pitches": pr.shape[0],
        "annotationRange": annotation_range,
        "notes": result["notes"][["on", "off", "pitch", "vel"]].to_numpy().tolist(),
        "size": len(matrix), "matrix": matrix_bytes(matrix),
        "lines": [line for line in lines if line[0] != line[2]], "shortLines": result["short_lines"],
        "rectangles": result["rectangles"], "rectangleRemovedCounts": result["rectangle_removed_counts"],
        "removedLineCount": result["removed_line_count"], "nodes": nodes,
        "splitSources": result["split_sources"],
        "elapsedMs": round((time.perf_counter() - start) * 1000),
    }


@lru_cache(maxsize=4)
def example_result(key, options):
    file, label = EXAMPLES[key]
    return analyze(file, label, dict(options))


def html_document(payload=None):
    template = (WEB / "index.html").read_text(encoding="utf-8")
    if payload is None:
        return template
    # Prevent MIDI metadata from closing the embedded script tag.
    data = json.dumps(payload, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")
    style = (WEB / "style.css").read_text(encoding="utf-8")
    script = (WEB / "app.js").read_text(encoding="utf-8")
    tags = f'<script id="embedded" type="application/json">{data}</script><script>{script}</script>'
    return (template.replace('<link rel="stylesheet" href="style.css">', f"<style>{style}</style>")
            .replace('<script src="music-preview/preview.js" defer></script>', preview_html())
            .replace('<script src="app.js" defer></script>', "")
            .replace("</body>", tags + "</body>"))


class Handler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        # The Windows console can pause writes while text is selected.
        # Serving a local request must not wait for the access log.
        pass

    def send_bytes(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, result, status=200):
        self.send_bytes(json.dumps(result, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/music-preview/offline.html":
            self.send_bytes(preview_html().encode(), "text/html; charset=utf-8")
            return
        preview = re.fullmatch(r"/music-preview/((?:samples/)?[a-z0-9_-]+\.js)", url.path)
        if preview:
            file = PREVIEW_ASSETS / preview[1]
            if not file.is_file():
                self.send_error(404)
                return
            self.send_bytes(file.read_bytes(), "text/javascript; charset=utf-8")
            return
        assets = {"/": ("index.html", "text/html"), "/style.css": ("style.css", "text/css"),
                  "/app.js": ("app.js", "text/javascript")}
        if url.path in assets:
            file, mime = assets[url.path]
            self.send_bytes((WEB / file).read_bytes(), mime + "; charset=utf-8")
            return
        if url.path == "/api/presets":
            try:
                self.send_json(list_presets())
            except OSError:
                self.send_json({"error": "无法读取参数方案。"}, 500)
            return
        if url.path == "/api/examples":
            self.send_json([{"id": song["id"], "name": song["name"]} for song in CLASSICAL])
            return
        if url.path != "/api/example":
            self.send_error(404)
            return
        params = {key: values[0] for key, values in parse_qs(url.query).items()}
        key = params.pop("key", "elise")
        if key not in EXAMPLES:
            self.send_json({"error": "找不到 MIDI 示例。"}, 404)
            return
        try:
            config = config_from(params)
            with ANALYSIS_SLOT:
                payload = example_result(key, tuple(config.items()))
            self.send_json(payload)
        except MatrixSizeError as error:
            self.send_json(matrix_size_error(error, config), 400)
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == "/api/presets":
            if self.headers.get_content_type() != "application/json":
                self.send_json({"error": "参数方案必须为 JSON。"}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 8192:
                    raise ValueError("参数方案的大小无效。")
                self.send_json(save_preset(json.loads(self.rfile.read(length))), 201)
            except (ValueError, TypeError, OverflowError):
                self.send_json({"error": "参数方案格式或取值无效。"}, 400)
            except OSError:
                self.send_json({"error": "无法写入参数方案。"}, 500)
            return
        if url.path not in {"/api/tracks", "/api/analyze"}:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= MAX_FILE_BYTES:
                raise ValueError("请选择不超过 2 MB 的 MIDI 文件。")
            name = Path(unquote(self.headers.get("X-Midi-Name", "upload.mid"))).name
            body = self.rfile.read(length)
            if not body.startswith(b"MThd"):
                raise ValueError("文件没有有效的 MIDI 文件头。")
            params = {key: values[0] for key, values in parse_qs(url.query).items()}
            annotation_range = None
            if "annotationStart" in params or "annotationEnd" in params:
                left = int(params.pop("annotationStart", "0"))
                right = int(params.pop("annotationEnd", "0"))
                if not 0 <= left < right <= 2**53 - 1:
                    raise ValueError("标注时间范围无效。")
                annotation_range = (left, right)
            config = config_from(params)
            with tempfile.TemporaryDirectory() as folder:
                file = Path(folder) / "upload.mid"
                file.write_bytes(body)
                with ANALYSIS_SLOT:
                    if url.path == "/api/tracks":
                        _, meta = read_midi_as_track_dfs(file)
                        payload = {"tracks": track_meta(meta)}
                    else:
                        payload = analyze(file, name, config, annotation_range)
            self.send_json(payload)
        except MatrixSizeError as error:
            self.send_json(matrix_size_error(error, config), 400)
        except (ValueError, OSError, EOFError, IndexError, KeyError) as error:
            self.send_json({"error": str(error) or "无法读取 MIDI 文件。"}, 400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=8766, type=int)
    parser.add_argument("--export", type=Path, help="Write one standalone HTML analysis")
    parser.add_argument("--midi", type=Path, help="MIDI to use for the HTML export")
    parser.add_argument("--track", type=int, default=0)
    parser.add_argument("--mode", choices=("NCC", "SAD", "TEXTON"), default="NCC")
    parser.add_argument("--stride", type=float, default=1.0)
    parser.add_argument("--threshold", type=float, default=DEFAULTS["threshold"])
    parser.add_argument("--split-overlaps", action=argparse.BooleanOptionalAction, default=DEFAULTS["splitOverlaps"])
    parser.add_argument("--split-min-beats", type=float, default=SPLIT_MIN_BEATS)
    parser.add_argument("--parent-edge-tolerance", type=float, default=PARENT_EDGE_TOLERANCE_BEATS,
                        help="Maximum parent-child edge difference to align, in beats")
    parser.add_argument("--min-beats", type=int, default=DEFAULTS["minBeats"])
    parser.add_argument("--rectangle-min-beats", type=float, default=DEFAULTS["rectangleMinBeats"])
    parser.add_argument("--remove-self-similarity", action=argparse.BooleanOptionalAction,
                        default=DEFAULTS["removeSelfSimilarity"])
    args = parser.parse_args()
    if args.export:
        file, label = EXAMPLES["elise"]
        midi = args.midi or file
        config = config_from({"track": args.track, "mode": args.mode, "stride": args.stride,
                              "threshold": args.threshold, "minBeats": args.min_beats,
                              "splitOverlaps": args.split_overlaps, "rectangleMinBeats": args.rectangle_min_beats,
                              "splitMinBeats": args.split_min_beats,
                              "parentEdgeTolerance": args.parent_edge_tolerance,
                              "removeSelfSimilarity": args.remove_self_similarity})
        args.export.write_text(html_document(analyze(midi, midi.name if args.midi else label, config)), encoding="utf-8")
        print(args.export.resolve())
        return
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
