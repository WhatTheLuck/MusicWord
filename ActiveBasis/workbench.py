"""Local MIDI workbench requests, transported as UTF-8 JSON over stdin/stdout."""

import io
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parent
POP909 = Path(os.environ.get("ACTIVE_BASIS_POP909") or next(
    (path for path in (ROOT / "POP909-Dataset" / "POP909",
                       ROOT.parent.parent / "MidiParser" / "POP909") if path.is_dir()),
    ROOT / "POP909-Dataset" / "POP909",
))


def catalog(root=POP909):
    names = {}
    try:
        with ZipFile(root / "index.xlsx") as book:
            strings = ["".join(item.itertext()) for item in ElementTree.fromstring(
                book.read("xl/sharedStrings.xml")
            )]
            rows = ElementTree.fromstring(book.read("xl/worksheets/sheet1.xml")).findall(".//{*}row")
            for row in rows[1:]:
                cells = {cell.attrib["r"][0]: cell for cell in row}
                if not {"A", "B"} <= cells.keys():
                    continue
                values = [cells[column].findtext("{*}v") for column in ("A", "B")]
                if all(value is not None for value in values):
                    ident, name = [strings[int(value)] if cells[column].get("t") == "s" else value
                                   for column, value in zip(("A", "B"), values)]
                    if ident.isdecimal():
                        names[ident.zfill(3)] = name
    except (OSError, BadZipFile, KeyError, ElementTree.ParseError, ValueError, IndexError):
        pass
    return [{"id": path.stem, "name": names.get(path.stem, path.stem)}
            for path in sorted(root.glob("[0-9][0-9][0-9]/*.mid"))
            if path.stem == path.parent.name]


def open_midi(request):
    from base64 import b64decode
    from mido import MidiFile

    if request.get("midi"):
        return MidiFile(file=io.BytesIO(b64decode(request["midi"], validate=True)))
    ident = request.get("id", "")
    if not re.fullmatch(r"[0-9]{3}", ident):
        raise ValueError("请选择 POP909 曲目或本地 MIDI")
    return MidiFile(POP909 / ident / (ident + ".mid"))


def bounded(settings, key, default, minimum, maximum, cast=int):
    value = cast(settings.get(key, default))
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} 必须在 {minimum} 到 {maximum} 之间")
    return value


def annotation_boxes(song, song_id, track, resolution):
    from playback import annotation_packet
    from song_data import quantize

    packet = annotation_packet(song_id, track)
    if not packet:
        return []
    versions = packet["versions"]
    dictionary = versions.get("dictionary")
    version = dictionary if dictionary and dictionary["instances"] else versions.get("csv")
    if not version:
        return []
    boxes = []
    offset = song.time_pad - song.tick_origin
    for instance in version["instances"]:
        if not instance["notes"]:
            continue
        pitches, starts, ends = zip(*instance["notes"])
        left, right = quantize([min(starts), max(ends)], packet["resolution"], resolution)
        boxes.append((int(left) + offset, min(pitches) - song.pitch_origin,
                      max(int(left) + 1, int(right)) + offset, max(pitches) - song.pitch_origin + 1))
    return boxes


def configuration(settings):
    from active_basis import LearningConfig

    defaults = LearningConfig()
    raw_scales = settings.get("scales")
    try:
        pitch_scales = defaults.pitch_scales if raw_scales is None else tuple(dict.fromkeys(
            float(value) for value in re.split(r"[,，\s]+", str(raw_scales).strip())
        ))
    except ValueError:
        pitch_scales = ()
    if not 1 <= len(pitch_scales) <= 7 or not all(0.25 <= scale <= 3 for scale in pitch_scales):
        raise ValueError("请输入 1–7 个音高缩放倍率，每个倍率为 0.25–3")
    note_min = bounded(settings, "noteMin", defaults.initial_note_count[0], 1, 20)
    note_max = bounded(settings, "noteMax", defaults.initial_note_count[1] - 1, note_min, 20)
    duration_min = bounded(settings, "durationMin", defaults.initial_duration[0], 0, 96)
    duration_max = bounded(settings, "duration", defaults.initial_duration[1] - 1, duration_min, 96)
    learned_min = bounded(settings, "learnedMin", defaults.minimum_learned_notes, 1, 32)
    learned_max = bounded(settings, "learnedMax", defaults.maximum_learned_notes, learned_min, 32)
    margin = bounded(settings, "captureMargin", defaults.capture_margin, 0, 64)
    blur_size = bounded(settings, "blur", defaults.blur_size, 1, 11)
    sigma = bounded(settings, "sigma", defaults.random_sigma, 0.1, 5, float)
    shared_size = blur_size if "blur" in settings else None
    shared_sigma = sigma if "sigma" in settings else None
    return LearningConfig(
        initial_templates=bounded(settings, "words", defaults.initial_templates, 1, 12),
        dictionary_growth=bounded(settings, "growth", defaults.dictionary_growth, 0, 12),
        initial_shape=(bounded(settings, "height", defaults.initial_shape[0], 2, 32),
                       bounded(settings, "width", defaults.initial_shape[1], 2, 96)),
        initial_note_count=(note_min, note_max + 1),
        initial_duration=(duration_min, duration_max + 1),
        pitch_scales=pitch_scales,
        blur_size=blur_size,
        random_sigma=sigma,
        learned_sigma=bounded(settings, "learnedSigma", shared_sigma or defaults.learned_sigma, 0.1, 5, float),
        uniqueness_threshold=bounded(settings, "similarity", defaults.uniqueness_threshold, 0, 1, float),
        usefulness_threshold=bounded(settings, "usefulness", defaults.usefulness_threshold, 0.05, 2, float),
        max_template_attempts=bounded(settings, "attempts", defaults.max_template_attempts, 1, 500),
        response_threshold=bounded(settings, "threshold", defaults.response_threshold, 0.05, 2, float),
        note_penalty=bounded(settings, "notePenalty", defaults.note_penalty, 0, 1, float),
        learned_penalty=bounded(settings, "learnedPenalty", defaults.learned_penalty, 0, 2, float),
        repulsion=bounded(settings, "repulsion", defaults.repulsion, 0, 2, float),
        capture_margin=margin,
        capture_pitch_margin=bounded(settings, "capturePitchMargin", margin, 0, 64) if "capturePitchMargin" in settings else None,
        capture_time_margin=bounded(settings, "captureTimeMargin", margin, 0, 64) if "captureTimeMargin" in settings else None,
        minimum_captures=bounded(settings, "minimumCaptures", defaults.minimum_captures, 1, 999),
        merge_threshold=bounded(settings, "merge", defaults.merge_threshold, 0, 1, float),
        spawn_blur_size=bounded(settings, "spawnBlur", shared_size or defaults.spawn_blur_size, 1, 11),
        spawn_sigma=bounded(settings, "spawnSigma", shared_sigma or defaults.spawn_sigma, 0.1, 5, float),
        spawn_ratio=bounded(settings, "spawnRatio", defaults.spawn_ratio, 0.01, 1, float),
        minimum_learned_notes=learned_min,
        maximum_learned_notes=learned_max,
        reference_blur_size=bounded(settings, "referenceBlur", shared_size or defaults.reference_blur_size, 1, 11),
        reference_sigma=bounded(settings, "referenceSigma", shared_sigma or defaults.reference_sigma, 0.1, 5, float),
    )


def training_checkpoint(dictionary, rng):
    _, keys, position, has_gauss, gauss = rng.get_state()
    return {
        "dictionary": [None if template is None else [
            [note.pitch, note.tick, note.duration] for note in template.notes
        ] for template in dictionary],
        "random": [keys.tolist(), position, has_gauss, gauss],
    }


def restore_random(state, rng):
    import numpy as np

    keys, position, has_gauss, gauss = state
    if len(keys) != 624 or not 0 <= position <= 624 or has_gauss not in (0, 1):
        raise ValueError("续训的随机状态无效。")
    rng.set_state(("MT19937", np.asarray(keys, dtype=np.uint32), position, has_gauss, gauss))


def restore_dictionary(slots, rolls, config):
    from active_basis import Basis, Template, render_notes

    height = max(roll.shape[0] for roll in rolls)
    width = max(roll.shape[1] for roll in rolls)
    max_pitch = round((height - 1) / min(config.pitch_scales))
    dictionary = []
    for slot in slots:
        if slot is None:
            dictionary.append(None)
            continue
        notes = [Basis(*note) for note in slot]
        if not config.minimum_learned_notes <= len(notes) <= config.maximum_learned_notes or any(
            not (0 <= note.pitch <= max_pitch and 0 <= note.tick < width
                 and 0 <= note.duration < width and note.tick + note.duration < width)
            for note in notes
        ):
            raise ValueError("续训的字典状态无效。")
        dictionary.append(Template(notes, render_notes(notes), learned=True))
    if len(dictionary) < config.initial_templates:
        raise ValueError("续训的字典状态无效。")
    return dictionary


def train_round(dictionary, rolls, config, rng, recorder):
    from active_basis import encode, prepare_dictionary, relearn

    if None not in dictionary:
        dictionary.extend([None] * config.dictionary_growth)
    recorder.start_round()
    variants = prepare_dictionary(dictionary, rolls, rng, config, recorder)
    recorder.prepared(dictionary, variants)
    matches, reconstructions = encode(rolls, variants, config, recorder)
    return relearn(rolls, matches, len(dictionary), config, recorder), matches, reconstructions


def unpack_playback_roll(packet):
    from base64 import b64decode
    import numpy as np

    width, height, low, high, encoded, *_ = packet
    if width <= 0 or height <= 0 or (low, high) != (0, 2.55):
        raise ValueError("回放的量化乐谱格式不支持续训。")
    return np.frombuffer(b64decode(encoded, validate=True), dtype=np.uint8).reshape(height, width) / 100


def playback_slots(slots):
    # Relearning frames record each basis before the template is shifted to its origin.
    dictionary = []
    for notes in slots:
        if notes is None:
            dictionary.append(None)
            continue
        tick_origin = min(note[0] for note in notes)
        pitch_origin = min(note[1] for note in notes)
        dictionary.append([[pitch - pitch_origin, tick - tick_origin, duration]
                           for tick, pitch, duration in notes])
    return dictionary


def continue_playback(request):
    import numpy as np
    from active_basis import LearningConfig, random_template
    from playback import PlaybackRecorder
    from song_data import average_iou

    seed = bounded(request, "seed", 37, 0, 2**32 - 1)
    config = LearningConfig(**request["config"])
    songs = request["songs"]
    rolls = [unpack_playback_roll(song["roll"]) for song in songs]
    rng = np.random.RandomState(seed)
    checkpoint = request.get("checkpoint")
    if checkpoint is not None:
        restore_random(checkpoint["random"], rng)
        slots = checkpoint["dictionary"]
    else:
        # Each random candidate consumes one draw sequence. Reuse the original
        # generator to recover its state without rerunning any score matching.
        actual = None
        for _ in range(request["randomTrials"]):
            candidate = random_template(rng, config)
        expected = request.get("lastRandomNotes")
        if request["randomTrials"]:
            actual = [[note.tick, note.pitch, note.duration] for note in candidate.notes]
        if expected and actual != expected:
            raise ValueError("无法恢复此回放的随机状态。")
        slots = playback_slots(request["dictionary"])
    dictionary = restore_dictionary(slots, rolls, config)
    recorder = PlaybackRecorder(None, None, seed, None, config, rounds_only=True)
    dictionary, matches, reconstructions = train_round(dictionary, rolls, config, rng, recorder)
    metrics = {
        "RMSE": float(np.mean([np.sqrt(np.mean((roll - reconstruction) ** 2))
                              for roll, reconstruction in zip(rolls, reconstructions)])),
    }
    if all("boxes" in song for song in songs):
        metrics["Average IOU"] = float(np.mean([average_iou(song["boxes"], [match.box for match in found])
                                               for song, found in zip(songs, matches)]))
    return recorder.data | {"metrics": [[metrics.get(name) for name in request["metricNames"]]],
                            "checkpoint": training_checkpoint(dictionary, rng)}


def run(request):
    action = request["action"]
    if action == "annotation-metrics":
        import numpy as np
        from song_data import METRIC_NAMES, annotation_scores

        tracks = request["tracks"]
        if not tracks:
            raise ValueError("没有可对齐的人工标注。")
        scores = [
            annotation_scores(track["manualBoxes"], track["predictedBoxes"],
                              track["manualLabels"], track["predictedLabels"])
            for track in tracks
        ]
        return dict(zip(METRIC_NAMES[:-1], np.mean(scores, axis=0).tolist()))
    if action == "catalog":
        return catalog()
    if action == "examples":
        from playback import similarity_examples

        return similarity_examples(configuration(request.get("settings", {})))
    if action == "continue-playback":
        return continue_playback(request)
    midi = open_midi(request)
    from song_data import TICKS_PER_BEAT, load_song, load_track

    if action == "tracks":
        tracks = []
        for index, track in enumerate(midi.tracks):
            try:
                _, pitches, starts, ends = load_track(midi, index)
            except ValueError:
                continue
            notes = sorted(zip(starts.tolist(), ends.tolist(), pitches.tolist()))
            signature = sha256(json.dumps(notes, separators=(",", ":")).encode("ascii")).hexdigest()
            tracks.append({"id": index, "name": track.name, "notes": len(pitches), "signature": signature})
        return tracks

    import numpy as np
    from playback import PlaybackRecorder, pack_preview

    settings = request.get("settings", {})
    config = configuration(settings)
    track = int(request["track"])
    resolution = bounded(settings, "resolution", TICKS_PER_BEAT, 4, 96)
    candidate_height = round((config.initial_shape[0] - 1) * max(config.pitch_scales)) + config.blur_size
    minimum_pitch_range = bounded(settings, "minPitchRange", candidate_height, 0, 128)
    annotation_range = request.get("annotationRange")
    if annotation_range is not None and (
            not isinstance(annotation_range, list) or len(annotation_range) != 2 or
            not all(type(value) is int for value in annotation_range) or
            not 0 <= annotation_range[0] < annotation_range[1] <= 2**53 - 1):
        raise ValueError("标注时间范围无效")
    song = load_song(midi, None, track, config.blur_size, ticks_per_beat=resolution,
                     minimum_pitch_range=minimum_pitch_range, annotation_range=annotation_range)
    if action == "preview":
        return pack_preview(song, config, resolution)
    if action not in ("train", "continue"):
        raise ValueError("未知操作")

    continuing = action == "continue"
    count = 1 if continuing else int(settings.get("rounds", 2))
    if count < 1:
        raise ValueError("训练轮数至少为 1")
    seed = bounded(settings, "seed", 37, 0, 2**32 - 1)
    if not continuing and not request.get("midi"):
        song.boxes = annotation_boxes(song, request["id"], track, resolution)
    recorder = PlaybackRecorder([0], track, seed, [song], config, resolution=resolution, rounds_only=continuing)
    if not continuing:
        recorder.data["minimumPitchRange"] = minimum_pitch_range
        recorder.data["songs"][0]["id"] = str(request.get("id") or "MIDI")
    rng = np.random.RandomState(seed)
    rolls = [song.roll]
    if continuing:
        checkpoint = request["checkpoint"]
        restore_random(checkpoint["random"], rng)
        dictionary = restore_dictionary(checkpoint["dictionary"], rolls, config)
    else:
        dictionary = [None] * config.initial_templates
    history = []
    for _ in range(count):
        dictionary, _, reconstructed = train_round(dictionary, rolls, config, rng, recorder)
        history.append([float(np.sqrt(np.mean((song.roll - reconstructed[0]) ** 2)))])
    return recorder.data | {"metricNames": ["RMSE"], "metrics": history,
                            "checkpoint": training_checkpoint(dictionary, rng)}


if __name__ == "__main__":
    try:
        result = run(json.load(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")))
        output = json.dumps({"result": result}, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (ValueError, OSError, EOFError, KeyError, TypeError, OverflowError) as error:
        output = json.dumps({"error": str(error)}, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))
