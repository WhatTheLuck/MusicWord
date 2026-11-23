"""Record a sparse-coding run for the offline browser player."""

from base64 import b64encode
from dataclasses import asdict
import json
from pathlib import Path
import re

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from preview_assets import preview_html


def annotation_packet(song_id, track):
    if not re.fullmatch(r"[0-9]{3}", str(song_id)):
        return None
    path = Path(__file__).with_name("web") / "public" / "annotations" / f"{song_id}-{track - 1}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def annotation_script(songs, track):
    annotations = {}
    for song in songs:
        packet = annotation_packet(song["id"], track)
        if packet:
            annotations[song["id"]] = {
                "resolution": packet["resolution"],
                "versions": {key: {"instances": version["instances"]} for key, version in packet["versions"].items()},
            }
    payload = json.dumps(annotations, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    return f'<script id="recorded-annotations" type="application/json">{payload}</script>'


def pack(matrix, bounds=None, *, precise=False):
    height, width = matrix.shape
    if precise:
        values = matrix.astype("<f4")
        low, high = 0.0, 1.0
    else:
        low, high = bounds or (float(matrix.min()), float(matrix.max()))
        scale = 255 / (high - low) if high > low else 0
        values = np.rint((matrix - low) * scale).clip(0, 255).astype(np.uint8)
    return [width, height, low, high, b64encode(values.tobytes()).decode("ascii"), precise]


def pack_roll(matrix):
    return pack(matrix, (0, 2.55))


def pack_preview(song, config, resolution):
    from active_basis import blur

    width = song.roll.shape[1] - song.time_pad
    height = song.roll.shape[0] - song.pitch_pad
    unpadded = song.roll[:height, song.time_pad:width]
    return {
        "roll": pack_roll(unpadded),
        "blurred": pack(blur(unpadded, config.blur_size, config.random_sigma, "same")),
        "pitchOrigin": song.pitch_origin, "tickOrigin": song.tick_origin,
        "notes": len(song.labels), "resolution": resolution,
        "pitchPad": song.pitch_pad, "timePad": song.time_pad,
    }


def similarity_maps(target, kernel, padding):
    """Evaluate the paper's patch matchers on the same sliding windows."""
    windows = sliding_window_view(np.pad(target, padding), kernel.shape)
    dot = np.einsum("ijkl,kl->ij", windows, kernel)
    window_energy = np.einsum("ijkl,ijkl->ij", windows, windows)
    kernel_energy = np.sum(kernel ** 2)
    energy = window_energy + kernel_energy
    bacc = np.divide(2 * dot, energy, out=np.zeros_like(dot), where=energy > 0)

    window_sum = windows.sum(axis=(-2, -1))
    window_std = np.sqrt(np.maximum(window_energy / kernel.size - (window_sum / kernel.size) ** 2, 0))
    kernel_std = kernel.std()
    epsilon = 1e-8
    denominator = kernel.size * (window_std + epsilon) * (kernel_std + epsilon)
    zncc = np.divide(
        dot - window_sum * kernel.mean(), denominator,
        out=np.zeros_like(dot), where=(window_std > epsilon) & (kernel_std > epsilon),
    )
    rmse = np.sqrt(np.maximum((energy - 2 * dot) / kernel.size, 0))
    return {"bacc": bacc, "zncc": zncc, "rmse": rmse}


def similarity_examples(config):
    from active_basis import Basis, blur, render_notes, scale_notes

    shape = (12, 26)
    notes = [Basis(pitch, tick, 3) for pitch, tick in [(0, 0), (2, 4), (4, 8), (5, 12)]]
    cases = [
        ("完全相同", notes, notes, "两侧的音高、起点和时长完全相同。"),
        ("单词音符较少", notes[:-1], notes, "单词少了乐谱片段中的最后一个音符。"),
        ("单词音符较多", [*notes, Basis(7, 16, 3)], notes, "单词末尾多出一个音符。"),
        ("微调起点和时长", notes, [notes[0], Basis(2, 5, 3), Basis(4, 8, 4), notes[3]],
         "第二个音符晚 1 格，第三个音符延长 1 格。"),
        ("一个音符音高改变", notes, [*notes[:-1], Basis(2, 12, 3)],
         "最后一个音符降低 3 个半音，起点和时长保持一致。"),
        ("整体平移", notes, [Basis(note.pitch + 2, note.tick + 3, note.duration) for note in notes],
         "所有音符整体升高 2 个半音、推迟 3 格。"),
        ("音高方向反转", notes, [Basis(5 - note.pitch, note.tick, note.duration) for note in notes],
         "反转音高走向，保留每个音符的起点和时长。"),
    ]
    padding = config.blur_size + shape[0]
    examples = []
    for label, word_notes, target_notes, description in cases:
        word = render_notes(word_notes, shape)
        target = render_notes(target_notes, shape)
        target_blurred = blur(target, config.blur_size, config.random_sigma)
        variants = {}
        for scale in config.pitch_scales:
            scaled = scale_notes(word_notes, scale)
            height = max(shape[0], max(note.pitch for note in scaled) + 1)
            kernel = blur(render_notes(scaled, (height, shape[1])), config.blur_size, config.random_sigma)
            variants[scale] = (kernel, similarity_maps(target_blurred, kernel, padding))
        ceiling = max(1, target_blurred.max(), *(kernel.max() for kernel, _ in variants.values()))
        scores = {}
        for metric in ("bacc", "zncc", "rmse"):
            if metric == "rmse":
                scale = min(variants, key=lambda key: variants[key][1][metric].min())
            else:
                scale = max(variants, key=lambda key: variants[key][1][metric].max())
            kernel, maps = variants[scale]
            raw = maps[metric]
            similarity = 1 - raw / ceiling if metric == "rmse" else raw
            position = np.unravel_index(similarity.argmax(), similarity.shape)
            response = np.clip(similarity, 0, 1)
            scores[metric] = {
                "matchKernel": pack(kernel), "scale": scale,
                "response": float(response[position]), "rmse": float(raw[position]) if metric == "rmse" else None,
                "responseMap": {
                    "matrix": pack(response, (0, 1)), "origin": -padding,
                    "position": [int(index) for index in position],
                },
            }
        examples.append({
            "label": label, "description": description,
            "left": pack_roll(word), "right": pack_roll(target),
            "wordBlur": [config.blur_size, config.random_sigma],
            "wordNotes": len(word_notes), "targetNotes": len(target_notes),
            "scores": scores,
        })
    return examples


class PlaybackRecorder:
    def __init__(self, song_ids, track, seed, songs, config, *, resolution=24, rounds_only=False):
        if rounds_only:
            self.data = {"rounds": []}
            return
        self.data = {
            "track": track,
            "config": asdict(config),
            "resolution": resolution,
            "examples": similarity_examples(config),
            "seed": seed,
            "threshold": config.response_threshold,
            "usefulness": config.usefulness_threshold,
            "uniqueness": config.uniqueness_threshold,
            "mergeThreshold": config.merge_threshold,
            "spawnRatio": config.spawn_ratio,
            "minimumCaptures": config.minimum_captures,
            "captureMargin": config.capture_margin,
            "repulsion": config.repulsion,
            "songs": [
                {
                    "id": f"{song_id:03d}",
                    "roll": pack_roll(song.roll),
                    "preview": pack_preview(song, config, resolution),
                    "pitchOrigin": song.pitch_origin,
                    "tickOrigin": song.tick_origin,
                    "pitchPad": song.pitch_pad,
                    "timePad": song.time_pad,
                    "notes": len(song.labels),
                    "boxes": song.boxes,
                }
                for song_id, song in zip(song_ids, songs)
            ],
            "rounds": [],
        }

    def start_round(self):
        self.current = {key: [] for key in ("trials", "dictionary", "variants", "matches", "captures", "density", "learning")}
        self.current["trialReferences"] = {}
        self.data["rounds"].append(self.current)

    def trial_references(self, template_id, references):
        self.current["trialReferences"][template_id] = {index: pack_roll(template.matrix) for index, template in references}

    def trial(self, template_id, template, response=None, threshold=None, *, similarity=None, comparisons=None):
        finite = response is not None and np.isfinite(response)
        self.current["trials"].append({
            "template": template_id,
            "learned": template.learned,
            "matrix": pack_roll(template.matrix),
            "count": len(template.notes),
            "notes": [[note.tick, note.pitch, note.duration] for note in template.notes],
            "response": float(response) if finite else None,
            "accepted": bool(finite and response >= threshold),
            "similarity": similarity,
            "comparisons": comparisons,
        })

    def prepared(self, dictionary, variants):
        self.current["dictionary"] = [
            pack_roll(template.matrix) if template is not None else None for template in dictionary
        ]
        for variant in variants:
            responses = {}
            for song_index, matrix in variant.responses.items():
                stride = (matrix.shape[1] + 767) // 768
                pooled = np.maximum.reduceat(matrix, np.arange(0, matrix.shape[1], stride), axis=1)
                responses[song_index] = {
                    "matrix": pack(pooled),
                    "stride": stride,
                    "width": matrix.shape[1],
                    "peak": float(matrix.max()),
                    "position": [int(index) for index in np.unravel_index(matrix.argmax(), matrix.shape)],
                }
            self.current["variants"].append({
                "template": variant.template_id, "scale": variant.pitch_scale,
                "matrix": pack_roll(variant.matrix), "blurred": pack(variant.blurred, precise=True),
                "responses": responses,
            })

    def ranking(self, entries):
        self.ranked = sorted(entries, key=lambda entry: entry[2], reverse=True)

    def match(self, song_index, match, score, start, before, after):
        bounds = (min(float(before.min()), float(after.min())), max(float(before.max()), float(after.max())))
        self.current["matches"].append({
            "song": song_index, "template": match.template_id, "scale": match.pitch_scale,
            "box": [int(edge) for edge in match.box], "score": float(score), "start": int(start),
            "before": pack(before, bounds), "after": pack(after, bounds),
            "ranking": self.ranked,
        })

    def capture(self, song_index, match_index, patch, restored, count):
        self.current["captures"].append({
            "song": song_index, "match": match_index, "count": count,
            "crop": pack_roll(patch), "restored": pack_roll(restored),
        })

    def density(self, template_id, count, density=None):
        self.current["density"].append({
            "template": template_id, "count": count,
            "matrix": pack(density) if density is not None else None,
        })

    def merge(self, template_id, absorbed_id, count, similarity, previous, current, merged):
        self.current["density"].append({
            "template": template_id, "absorbed": absorbed_id, "count": count,
            "similarity": similarity,
            "previous": pack(previous), "current": pack(current), "matrix": pack(merged),
        })

    def basis_recorder(self, template_id, density):
        peak = float(density.max())
        initial = pack(density, (0, peak))

        def record(note, count, painted, remaining):
            self.current["learning"].append({
                "template": template_id, "count": count,
                "note": [note.tick, note.pitch, note.duration],
                "matrix": pack_roll(painted), "density": initial,
                "remaining": pack(np.maximum(remaining, 0), (0, peak)),
            })

        return record

    def learned(self, template_id, template):
        self.current["learning"].append({
            "template": template_id,
            "result": pack_roll(template.matrix) if template is not None else None,
        })

    def write(self, output, metrics_names, metrics_history):
        self.data["metricNames"] = metrics_names
        self.data["metrics"] = [row.tolist() for row in metrics_history]
        web = Path(__file__).with_name("web")
        html = (web / "index.html").read_text(encoding="utf-8")
        data = json.dumps(self.data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        styles = (web / "player.css").read_text(encoding="utf-8")
        script = (web / "player.js").read_text(encoding="utf-8")
        embedded_data = data.replace("<", "\\u003c")
        html = html.replace('<link rel="stylesheet" href="./player.css">', f"<style>{styles}</style>")
        html = html.replace('<script defer src="/music-preview/preview.js"></script>', preview_html())
        html = html.replace(
            '<script type="module" src="./player.js"></script>',
            f'<script id="training-data" type="application/json">{embedded_data}</script>\n'
            f'{annotation_script(self.data["songs"], self.data["track"])}\n'
            f'<script type="module">{script}</script>',
        )
        output.write_text(html, encoding="utf-8")
