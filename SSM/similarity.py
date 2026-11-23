"""Beat-aligned similarity kernels and repeat extraction."""
import math

import numpy as np
from scipy import signal
from scipy.spatial.distance import cdist

BLUR_SIZE = 4
BLUR_SIGMA = 1.0
BLOCK_ROWS = 128


def stride_ticks(beat_stride, tpb):
    if not math.isfinite(beat_stride) or beat_stride <= 0 or tpb <= 0:
        raise ValueError("分析步长和每拍刻度必须大于零。")
    stride = round(beat_stride * tpb)
    if stride < 1:
        raise ValueError("分析步长小于一个量化刻度。")
    return stride


def cross_correlate(kernel, feature_map, pad_mode="full", stride=1):
    kernel = np.asarray(kernel, dtype=np.float32)
    feature_map = np.asarray(feature_map, dtype=np.float32)
    if pad_mode == "same":
        # Match the old conv2d padding, including the even-kernel alignment.
        padding = tuple(((size - 1) // 2, size // 2) for size in kernel.shape)
        feature_map = np.pad(feature_map, padding)
    elif pad_mode == "full":
        feature_map = np.pad(feature_map, tuple((n - 1, n - 1) for n in kernel.shape))
    elif pad_mode != "valid":
        raise ValueError(f"Unknown padding mode: {pad_mode}")
    return signal.correlate2d(feature_map, kernel, mode="valid")[::stride, ::stride]


def blur(matrix, size=4, sigma=2, pad="same", normalize=1, divide_max=1):
    if size in (1, None):
        return matrix
    if size < 1 or not math.isfinite(sigma) or sigma <= 0:
        raise ValueError("高斯核尺寸和标准差必须大于零。")
    window = signal.windows.gaussian(size, std=sigma)
    window /= window.max() if divide_max else window.sum() if normalize else 1
    return cross_correlate(np.outer(window, window), matrix, pad_mode=pad)


def frame_vectors(piano_roll, stride):
    count = piano_roll.shape[1] // stride
    framed = piano_roll[:, :count * stride].reshape(piano_roll.shape[0], count, stride)
    return np.ascontiguousarray(framed.transpose(1, 0, 2).reshape(count, -1), dtype=np.float32)


def centered_unit_rows(frames):
    centered = frames - frames.mean(axis=1, keepdims=True)
    norms = np.linalg.norm(centered, axis=1, keepdims=True)
    return centered / np.where(norms > 0, norms, 1)


def SSM_matrix(pr, ssm_beat_stride=0.5, mode="SAD", use_tpb=12,
               sigma=1.0, blur_size=BLUR_SIZE, blur_sigma=BLUR_SIGMA, *, note_on_weight=1.0):
    if getattr(pr, "ndim", 0) != 2:
        raise ValueError("钢琴卷帘必须是二维矩阵。")
    mode = mode.upper()
    stride = stride_ticks(ssm_beat_stride, use_tpb)
    if mode == "TEXTON":
        if stride != use_tpb:
            raise ValueError("Texton 模式固定每拍比较一次。")
        from TextonOnBeat import get_ssm
        return get_ssm(pr, tpb=use_tpb, threshold=0, note_on_weight=note_on_weight, blur_size=blur_size, blur_sigma=blur_sigma)
    if mode not in {"NCC", "SAD"}:
        raise ValueError("相似度模式必须为 NCC、SAD 或 Texton。")
    if mode == "SAD" and (not math.isfinite(sigma) or sigma <= 0):
        raise ValueError("SAD 衰减系数必须大于零。")
    frames = pr.shape[1] // stride
    if not frames or not pr.shape[0]:
        return np.empty((0, 0), dtype=np.float32)

    left = frame_vectors(pr, stride)
    right = frame_vectors(blur(pr, blur_size, blur_sigma), stride)
    if mode == "NCC":
        left, right = centered_unit_rows(left), centered_unit_rows(right)
    result = np.full((frames, frames), np.nan, dtype=np.float32)
    columns = np.arange(frames)
    for start in range(0, frames, BLOCK_ROWS):
        end = min(start + BLOCK_ROWS, frames)
        if mode == "NCC":
            scores = left[start:end] @ right[:end].T
        else:
            scores = np.exp(-cdist(left[start:end], right[:end], metric="cityblock") / sigma)
        scores[columns[:end] > columns[start:end, None]] = np.nan
        result[start:end, :end] = scores
    return result


def compute_ssm(pr, ssm_beat_stride=0.5, use_tpb=12, ssm_mode="NCC",
                sigma=1.0, blur_size=BLUR_SIZE, blur_sigma=BLUR_SIGMA, *, note_on_weight=1.0):
    stride = stride_ticks(ssm_beat_stride, use_tpb)
    return SSM_matrix(pr, ssm_beat_stride, ssm_mode, use_tpb, sigma, blur_size, blur_sigma,
                      note_on_weight=note_on_weight), stride


def ssm_filter(ssm, thr=0.0):
    filtered = np.array(ssm, dtype=np.float32, copy=True)
    filtered[filtered < thr] = 0
    return filtered


def find_ssm_rectangles(ssm, stride_tick, min_side_ticks):
    """Return maximal solid rectangles whose width and height both exceed the threshold."""
    qualified = np.tril(np.isfinite(ssm) & (ssm > 0))
    size = len(qualified)
    heights = np.zeros(size, dtype=np.intp)
    rectangles = []
    for row, cells in enumerate(qualified):
        heights = np.where(cells, heights + 1, 0)
        # A range sum tests whether the entire rectangle can extend down one row.
        below = (np.r_[0, np.cumsum(qualified[row + 1])] if row + 1 < size
                 else np.zeros(size + 1, dtype=np.intp))
        stack = []
        for col, height in enumerate([*heights.tolist(), 0]):
            left = col
            while stack and stack[-1][1] > height:
                left, previous_height = stack.pop()
                width = col - left
                if (min(width, previous_height) * stride_tick > min_side_ticks
                        and below[col] - below[left] < width):
                    rectangles.append((left, row + 1 - previous_height, width, previous_height))
            if height and (not stack or stack[-1][1] < height):
                stack.append((left, height))
    return rectangles


def remove_redundant_ssm_diagonals(lines, rectangles, stride_tick):
    """Return the kept lines and number removed from each containing rectangle."""
    if not rectangles:
        return set(lines), []

    bounds = np.asarray(rectangles, dtype=np.intp)
    left, top, width, height = bounds.T
    right, bottom = left + width, top + height
    # Only look at rectangles that intersect the tile containing the first cell.
    tile_size = 32
    tiles = {}
    for index, (col, row, cols, rows) in enumerate(rectangles):
        for tile_row in range(row // tile_size, (row + rows - 1) // tile_size + 1):
            for tile_col in range(col // tile_size, (col + cols - 1) // tile_size + 1):
                tiles.setdefault((tile_col, tile_row), []).append(index)
    tiles = {tile: np.asarray(indices, dtype=np.intp) for tile, indices in tiles.items()}
    occupied = np.zeros(len(bounds), dtype=bool)
    removed = np.zeros(len(bounds), dtype=np.intp)
    kept = set()
    # The diagonal detector scans offsets first and then start cells.
    for line in sorted(lines, key=lambda line: (line[0] - line[1], line[2] - line[0], line[0])):
        x0, x1, y0, y1 = (int(tick // stride_tick) for tick in line)
        nearby = tiles.get((x0 // tile_size, y0 // tile_size))
        if nearby is None:
            kept.add(line)
            continue
        containing = nearby[(left[nearby] <= x0) & (top[nearby] <= y0)
                            & (x1 < right[nearby]) & (y1 < bottom[nearby])]
        if np.any(occupied[containing]):
            removed[containing] += 1
        else:
            kept.add(line)
            occupied[containing] = True
    return kept, removed.tolist()


def find_ssm_diag_lines(ssm, stride_tick, tick_offset=0, ssm_disp_range=None,
                        thr=0.0, min_len=2):
    if ssm is None:
        return []
    start, end = 0, len(ssm)
    if ssm_disp_range is not None:
        left, right = sorted(ssm_disp_range)
        start = max(0, math.floor(left / stride_tick))
        end = min(end, math.ceil(right / stride_tick))
    if end <= start:
        return []

    window = ssm[start:end, start:end]
    minimum = max(2, min_len)
    origin = tick_offset + (start + 0.5) * stride_tick
    lines = []
    for offset in range(len(window)):
        matches = np.diagonal(window, offset=-offset)
        mask = np.isfinite(matches) & (matches > thr)
        edges = np.flatnonzero(np.diff(mask, prepend=False, append=False))
        for first, stop in edges.reshape(-1, 2):
            if stop - first >= minimum:
                x0, x1 = origin + first * stride_tick, origin + (stop - 1) * stride_tick
                delay = offset * stride_tick
                lines.append((x0, x1, x0 + delay, x1 + delay))
    return lines
