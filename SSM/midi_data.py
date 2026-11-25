"""MIDI loading and beat-aligned piano roll construction."""
import hashlib
from io import BytesIO
from itertools import accumulate
import json

import mido
import numpy as np
import pandas as pd
import pretty_midi

TPB = 12
ASPECT = TPB / 4
NOTE_ON_WEIGHT = 1.0
DUR_WEIGHT = 0.2


def _compact_midi_ticks(midi):
    """Index only ticks with events when a dense tick table would be too large."""
    if max((sum(message.time for message in track) for track in midi.tracks), default=0) + 1 <= pretty_midi.MAX_TICK:
        return None
    ticks = {0}
    for track in midi.tracks:
        ticks.update(accumulate(message.time for message in track))
    original_ticks = sorted(ticks)
    index = {tick: position for position, tick in enumerate(original_ticks)}
    for track in midi.tracks:
        tick = previous = 0
        for message in track:
            tick += message.time
            current = index[tick]
            message.time = current - previous
            previous = current
    return original_ticks


def read_midi_as_track_dfs(path, use_tpb=TPB, *, annotation_range=None):
    """使用 pretty_midi 读取 MIDI，并将每个轨道转换为一个 DataFrame。

    注意：保留原始时间起点（不会把最早的 note_on 平移到 0）。
    """

    midi = mido.MidiFile(path)
    original_tpb = int(midi.ticks_per_beat)
    original_ticks = _compact_midi_ticks(midi)
    if original_ticks is None:
        pm = pretty_midi.PrettyMIDI(path)
    else:
        with BytesIO() as buffer:
            midi.save(file=buffer)
            buffer.seek(0)
            pm = pretty_midi.PrettyMIDI(buffer)

    def source_tick(seconds):
        tick = int(pm.time_to_tick(seconds))
        return original_ticks[tick] if original_ticks is not None else tick

    tempo_times, tempi = pm.get_tempo_changes()
    if len(tempi) == 0:
        bpm = float(pm.estimate_tempo())
    else:
        bpm = float(tempi[0])
        if original_ticks is not None:
            tempo_deltas = np.diff([source_tick(seconds) for seconds in tempo_times], prepend=0)
            tempo_times = np.cumsum(tempo_deltas * 60 / (original_tpb * np.r_[tempi[0], tempi[:-1]]))

    instruments_meta = []
    for idx, inst in enumerate(pm.instruments):
        instruments_meta.append(
            {
                "index": idx,
                "program": int(inst.program),
                "is_drum": bool(inst.is_drum),
                "name": inst.name,
                "n_notes": len(inst.notes),
            }
        )

    meta = {
        "bpm": bpm,
        "tpb": original_tpb,
        "use_tpb": int(use_tpb),
        "n_instruments": len(pm.instruments),
        "instruments": instruments_meta,
        "tempo_times": tempo_times,
        "tempi": tempi,
    }

    scale = float(use_tpb) / float(original_tpb) if original_tpb else 1.0
    if annotation_range is not None:
        left, right = annotation_range
        window_end = max(1, round((right - left) * scale))

    df_ls = []
    for instrument, inst in zip(instruments_meta, pm.instruments):
        rows = []
        source_notes = []
        for n in inst.notes:
            start, end = source_tick(n.start), source_tick(n.end)
            source_notes.append((start, end, int(n.pitch)))
            if annotation_range is not None:
                start, end = max(start, left), min(max(start + 1, end), right)
                if start >= end:
                    continue
                start, end = start - left, end - left
            on, off = int(round(start * scale)), int(round(end * scale))
            if annotation_range is not None:
                on = min(on, window_end - 1)
                off = min(window_end, max(on + 1, off))
            dur = max(0, off - on)
            rows.append(
                {
                    "on": on,
                    "off": off,
                    "dur": dur,
                    "pitch": int(n.pitch),
                    "vel": int(n.velocity),
                }
            )
        df = pd.DataFrame(rows, columns=["on", "off", "dur", "pitch", "vel"])
        df_ls.append(df)
        canonical = json.dumps(sorted(source_notes), separators=(",", ":"))
        instrument["signature"] = hashlib.sha256(canonical.encode("ascii")).hexdigest()

    meta["tracks"] = [
        {
            "index": m["index"],
            "program": m["program"],
            "is_drum": m["is_drum"],
            "name": m["name"],
        }
        for m in instruments_meta
    ]

    return df_ls, meta


def DF2PR(df, on_weight=NOTE_ON_WEIGHT, dur_weight=DUR_WEIGHT, return_crop_info=False,
          keep_time_origin=True):
    """df -> pianoroll。

    关键：默认 keep_time_origin=True，不再裁剪前置空白。
    """

    if len(df) == 0:
        pr = np.zeros((0, 0), dtype=np.float32)
        return (pr, 0, 0) if return_crop_info else pr

    if "note_on_tick" in df.columns:
        on_col, off_col = "note_on_tick", "note_off_tick"
    else:
        on_col, off_col = "on", "off"

    pitch = df["pitch"].to_numpy(dtype=np.int32)
    on = df[on_col].to_numpy(dtype=np.int64)
    off = df[off_col].to_numpy(dtype=np.int64)

    dur = (off - on).astype(np.int64)
    dur = np.maximum(dur, 0)

    min_pitch = int(pitch.min())
    max_pitch = int(pitch.max())
    pitch_range = max_pitch - min_pitch + 1

    if keep_time_origin:
        min_on = 0
    else:
        min_on = int(on.min())

    max_off = int(off.max())
    tick_range = max_off - min_on + 1

    pr = np.zeros((pitch_range, tick_range), dtype=np.float32)

    p_idx = pitch - min_pitch
    t_on = on - min_on
    valid = (t_on >= 0) & (t_on < tick_range)
    pr[p_idx[valid], t_on[valid]] = float(on_weight)

    if dur_weight != 0:
        for pi, t0, d in zip(p_idx, t_on, dur):
            if d <= 1:
                continue
            t1 = int(min(tick_range, t0 + d))
            t_start = int(max(0, t0 + 1))
            if t_start < t1:
                pr[pi, t_start:t1] = float(dur_weight)

    if return_crop_info:
        return pr, min_pitch, min_on
    return pr
