"""Load POP909 tracks and evaluate against the existing pattern annotations."""

from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path

from mido import MidiFile
import numpy as np
from pandas.compat.pickle_compat import Unpickler
from scipy.optimize import linear_sum_assignment
from sklearn.metrics import adjusted_rand_score, homogeneity_completeness_v_measure

from active_basis import ONSET, SUSTAIN


TICKS_PER_BEAT = 24
MINIMUM_PITCH_RANGE = 40
METRIC_NAMES = ("Average IOU", "ARI", "Homogeneity", "Completeness", "V-Measure", "RMSE")
Box = tuple[int, int, int, int]


@dataclass
class Song:
    roll: np.ndarray
    pitches: np.ndarray
    onsets: np.ndarray
    labels: np.ndarray
    boxes: list[Box]
    pitch_origin: int
    tick_origin: int
    pitch_pad: int
    time_pad: int


class LabelTemplate:
    """Container restored from the legacy annotation pickles."""


class LabelUnpickler(Unpickler):
    def find_class(self, module, name):
        if module == "__main__" and name == "template":
            return LabelTemplate
        return super().find_class(module, name)


def load_track(path, track_number):
    midi = path if isinstance(path, MidiFile) else MidiFile(path)
    if not 0 <= track_number < len(midi.tracks):
        raise ValueError(f"{path}: MIDI track {track_number} does not exist")

    pending = defaultdict(deque)
    notes = []
    tick = 0
    for message in midi.tracks[track_number]:
        tick += message.time
        if message.type not in ("note_on", "note_off"):
            continue
        key = (message.channel, message.note)
        if message.type == "note_on" and message.velocity > 0:
            pending[key].append(len(notes))
            notes.append([message.note, tick, None])
        elif pending[key]:
            notes[pending[key].popleft()][2] = tick

    complete_notes = [note for note in notes if note[2] is not None]
    if not complete_notes:
        raise ValueError(f"{path}: MIDI track {track_number} has no complete notes")
    pitches, starts, ends = np.asarray(complete_notes).T
    return midi.ticks_per_beat, pitches, starts, ends


def quantize(ticks, source_resolution, ticks_per_beat=TICKS_PER_BEAT):
    return np.rint(np.asarray(ticks) * (ticks_per_beat / source_resolution)).astype(int)


def load_song(midi_path, label_path, track_number, blur_size, *, ticks_per_beat=TICKS_PER_BEAT,
              minimum_pitch_range=MINIMUM_PITCH_RANGE, annotation_range=None):
    resolution, pitches, starts, ends = load_track(midi_path, track_number)
    if resolution <= 0:
        raise ValueError("Only MIDI files with beat-based timing are supported")
    if annotation_range is not None:
        left, right = annotation_range
        ends = np.maximum(starts + 1, ends)
        keep = (starts < right) & (ends > left)
        if not keep.any():
            raise ValueError("标注时间范围内没有音符")
        pitches = pitches[keep]
        starts, ends = np.maximum(starts[keep], left), np.minimum(ends[keep], right)
    lengths = quantize(ends - starts, resolution, ticks_per_beat)
    starts = quantize(starts, resolution, ticks_per_beat)
    ends = quantize(ends, resolution, ticks_per_beat)
    pitch_origin = int(pitches.min())
    tick_origin = int(starts.min())
    height = int(pitches.max()) - pitch_origin + 1
    if annotation_range is None:
        # Preserve the trailing space of the original training roll.
        end_tick = max(int(ends.max() + lengths[-1]), int((starts + lengths).max()), int(starts.max()))
    else:
        tick_origin, right_tick = quantize(annotation_range, resolution, ticks_per_beat).tolist()
        end_tick = max(tick_origin, right_tick - 1)
        starts = np.minimum(starts, end_tick)
        lengths = np.minimum(end_tick + 1, np.maximum(starts + 1, ends)) - starts
    extra_pitches = max(0, minimum_pitch_range - height)
    time_pad = blur_size // 2 if extra_pitches else 0
    pitch_pad = 2 * ((extra_pitches + 1) // 2)
    if label_path is None and end_tick - tick_origin > 30000:
        raise ValueError("量化后超过 30,000 tick，请降低量化分辨率或选择较短的音轨")
    roll = np.zeros((height + pitch_pad, end_tick - tick_origin + 1 + 2 * time_pad))
    local_pitches = pitches - pitch_origin
    local_starts = starts - tick_origin + time_pad
    for pitch, start, duration in zip(local_pitches, local_starts, lengths):
        roll[pitch, start] = ONSET
        roll[pitch, start + 1:start + duration] = SUSTAIN

    groups = {}
    if label_path is not None:
        with Path(label_path).open("rb") as stream:
            groups = LabelUnpickler(stream).load()
    boxes = []
    label_by_note = {}
    for label, templates in groups.items():
        for template in templates:
            frame = template.template_df
            if frame.empty:
                continue
            label_pitches = frame.pitch.to_numpy() - pitch_origin
            label_starts = quantize(frame.note_on_tick, resolution, ticks_per_beat) - tick_origin + time_pad
            label_ends = quantize(frame.note_off_tick, resolution, ticks_per_beat) - tick_origin + time_pad
            boxes.append((
                int(label_starts.min()), int(label_pitches.min()),
                int(label_ends.max()), int(label_pitches.max()) + 1,
            ))
            for key in zip(label_pitches, label_starts):
                label_by_note[key] = label
    labels = np.asarray([label_by_note.get(key, -1) for key in zip(local_pitches, local_starts)])
    return Song(roll, local_pitches, local_starts, labels, boxes, pitch_origin, tick_origin, pitch_pad, time_pad)


def average_iou(expected, predicted):
    if not expected or not predicted:
        return 0.0
    expected = np.asarray(expected)[:, None, :]
    predicted = np.asarray(predicted)[None, :, :]
    top_left = np.maximum(expected[..., :2], predicted[..., :2])
    bottom_right = np.minimum(expected[..., 2:], predicted[..., 2:])
    intersection = np.maximum(bottom_right - top_left, 0).prod(axis=-1)
    union = (
        (expected[..., 2:] - expected[..., :2]).prod(axis=-1)
        + (predicted[..., 2:] - predicted[..., :2]).prod(axis=-1)
        - intersection
    )
    scores = np.divide(intersection, union, out=np.zeros_like(intersection, dtype=float), where=union > 0)
    rows, columns = linear_sum_assignment(scores, maximize=True)
    return float(scores[rows, columns].mean())


def annotation_scores(expected_boxes, predicted_boxes, expected_labels, predicted_labels):
    """Score segmentation and clustering independently of roll reconstruction."""
    expected_classes = np.unique(expected_labels, return_inverse=True)[1]
    predicted_classes = np.unique(predicted_labels, return_inverse=True)[1]
    return (
        average_iou(expected_boxes, predicted_boxes),
        adjusted_rand_score(expected_classes, predicted_classes),
        *homogeneity_completeness_v_measure(expected_classes, predicted_classes),
    )


def evaluate(songs, matches, reconstructions):
    scores = []
    for song, song_matches, reconstruction in zip(songs, matches, reconstructions):
        predicted = np.full_like(song.labels, -1)
        for match in song_matches:
            left, bottom, right, top = match.box
            inside = (
                (left <= song.onsets) & (song.onsets < right)
                & (bottom <= song.pitches) & (song.pitches < top)
            )
            predicted[inside] = match.template_id
        annotation = annotation_scores(song.boxes, [match.box for match in song_matches], song.labels, predicted)
        rmse = np.sqrt(np.mean((song.roll - reconstruction) ** 2))
        scores.append((*annotation, rmse))
    return np.mean(scores, axis=0)
