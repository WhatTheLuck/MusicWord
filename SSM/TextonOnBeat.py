"""One-beat SSM from the earlier pitch-shift Texton experiment."""
import numpy as np

from similarity import BLOCK_ROWS, blur, frame_vectors


def _normalize(frames):
    centered = frames - frames.mean(axis=1, keepdims=True)
    return centered / (np.sqrt(np.mean(centered ** 2, axis=1, keepdims=True)) + 1e-6)


def get_ssm(pr, beat_stride=1, beat_len=1, threshold=0.75, *, tpb=12,
            note_on_weight=1.0, blur_size=4, blur_sigma=1.0):
    """Compare beat templates with subsequent beats and return the lower triangle.

    The original row-wise maximum and onset gate are preserved. Shifted variants
    stop when a shift would remove notes from the pitch range. Input is read-only.
    """
    if beat_stride != 1 or beat_len != 1:
        raise ValueError("Texton 模式支持单拍模板和单拍步长。")
    count = pr.shape[1] // tpb
    if not count or not pr.shape[0]:
        return np.empty((0, 0), dtype=np.float32)
    gated = np.asarray(pr, dtype=np.float32).copy()
    full_beats = gated[:, :count * tpb].reshape(len(gated), count, tpb)
    silent = full_beats.max(axis=(0, 2)) < note_on_weight
    full_beats[:, silent] = 0

    original = frame_vectors(gated, tpb)
    target = _normalize(frame_vectors(blur(gated, blur_size, blur_sigma), tpb))
    mass = original.sum(axis=1)
    variants = [(np.ones(count, dtype=bool), _normalize(original))]
    pitch_frames = original.reshape(count, len(gated), tpb)
    for sign in (1, -1):
        valid = np.ones(count, dtype=bool)
        for shift in (2, 4, 6):
            shifted = np.zeros_like(pitch_frames)
            if shift < len(gated):
                if sign > 0:
                    shifted[:, shift:] = pitch_frames[:, :-shift]
                else:
                    shifted[:, :-shift] = pitch_frames[:, shift:]
            flat = shifted.reshape(count, -1)
            valid = valid & (flat.sum(axis=1) >= mass)
            if not np.any(valid & (mass > 0)):
                break
            variants.append((valid, _normalize(flat)))

    result = np.full((count, count), np.nan, dtype=np.float32)
    columns = np.arange(count)
    for start in range(0, count, BLOCK_ROWS):
        end = min(count, start + BLOCK_ROWS)
        earlier = columns[start:end, None]
        later = columns[None, start:]
        scores = np.zeros((end - start, count - start), dtype=np.float32)
        for valid, templates in variants:
            matrix = templates[start:end] @ target[start:].T
            np.maximum(scores, np.where(valid[start:end, None], matrix, 0), out=scores)
        size_mismatch = np.abs(mass[start:end, None] - mass[None, start:]) > 2 * note_on_weight
        scores[size_mismatch & (earlier != later)] = 0.01
        scores[(mass[start:end, None] <= 0) | (mass[None, start:] <= 0) | (earlier > later)] = 0
        peak = scores.max(axis=1, keepdims=True)
        scores /= np.where(peak > 0, peak, 1)
        scores[scores < threshold] = 0
        scores[earlier > later] = np.nan
        result[start:, start:end] = scores.T
    return result
