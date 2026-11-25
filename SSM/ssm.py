"""Public SSM API and shared single-track pipeline."""
from math import ceil
from pathlib import Path

import numpy as np

from midi_data import DF2PR, DUR_WEIGHT, NOTE_ON_WEIGHT, TPB, read_midi_as_track_dfs
from similarity import (BLUR_SIGMA, BLUR_SIZE, SSM_matrix, blur, compute_ssm,
                        cross_correlate, find_ssm_diag_lines, find_ssm_rectangles,
                        remove_redundant_ssm_diagonals, ssm_filter, stride_ticks)
from structure import (PARENT_EDGE_TOLERANCE_BEATS, build_hline_tree, layout_diag_lines,
                       merge_similarity_transitive, normalize_intervals_with_cut)

SSM_BEAT_STRIDE = 1
FILTER_THR = 0.3
MIN_LINE_BEAT_LEN = 6
SPLIT_MIN_BEATS = 2.0
SSM_DISP_RANGE_TICK = None
SSM_FIND_RANGE_IN_STRIDE_TICK = 10000
TREE_OVERLAP_POLICY = "keep"


class MatrixSizeError(ValueError):
    def __init__(self, ticks, pitches, frames, limit):
        super().__init__(f"当前步长需要 {frames} 格／轴，上限为 {limit} 格。")
        self.ticks = ticks
        self.pitches = pitches


_PLOT_NAMES = {
    "show_pr", "show_all_pr", "show_ssm_with_pr", "plot_anytree",
    "plot_tree_with_midi_slices_anytree", "plot_similarity_classes_stacked",
}


def __getattr__(name):
    if name in _PLOT_NAMES:
        import plots
        return getattr(plots, name)
    raise AttributeError(name)


def split_overlapping_diagonals(lines, stride_tick, min_length_tick=SPLIT_MIN_BEATS * TPB):
    """Split overlapping matches into disjoint pairs and drop short pieces."""
    pieces = []
    sources = []
    for line in lines:
        x0, x1, y0, y1 = line
        offset = y0 - x0
        length = x1 - x0 + stride_tick
        if not 0 < offset < length:
            pieces.append(line)
            continue
        # Each resulting piece is at most one offset long.
        if offset < min_length_tick:
            continue
        while length > offset:
            piece = (x0, x0 + offset - stride_tick, y0, y0 + offset - stride_tick)
            pieces.append(piece)
            sources.append((piece, line))
            x0 += offset
            y0 += offset
            length = x1 - x0 + stride_tick
        if length >= min_length_tick:
            piece = (x0, x1, y0, y1)
            pieces.append(piece)
            sources.append((piece, line))
    return pieces, sources


def run_singletrack_ssm_pipeline(
    *,
    midi_path: str,
    track_idx: int = 0,
    tpb: int = TPB,
    note_on_weight: float = NOTE_ON_WEIGHT,
    dur_weight: float = DUR_WEIGHT,
    ssm_beat_stride: float = SSM_BEAT_STRIDE,
    ssm_mode: str = "NCC",
    sigma: float = 1.0,
    filter_thr: float = FILTER_THR,
    min_line_beat_len: int = MIN_LINE_BEAT_LEN,
    ssm_disp_range_tick = SSM_DISP_RANGE_TICK,
    ssm_find_range_in_stride_tick: int = SSM_FIND_RANGE_IN_STRIDE_TICK,
    tree_overlap_policy: str = TREE_OVERLAP_POLICY,
    unique_min_len_tick: int | None = None,
    fill_min_len_tick: int | None = None,
    parent_edge_tolerance_beats: float = PARENT_EDGE_TOLERANCE_BEATS,
    blur_size: int = BLUR_SIZE,
    blur_sigma: float = BLUR_SIGMA,
    max_frames: int | None = None,
    max_roll_cells: int | None = None,
    max_structure_lines: int | None = None,
    split_overlaps: bool = False,
    split_min_beats: float = SPLIT_MIN_BEATS,
    include_raw_lines: bool = True,
    include_short_lines: bool = False,
    rectangle_min_beats: float | None = None,
    remove_self_similarity: bool = False,
    copy_leaf_matrices: bool = True,
    annotation_range: tuple[int, int] | None = None,
    plot: bool = False,
    plot_pr: bool | None = None,
    plot_ssm: bool | None = None,
    plot_tree: bool | None = None,
    plot_tree_midi_slices: bool | None = None,
    plot_leaves: bool | None = None,
):
    df_ls, meta = read_midi_as_track_dfs(midi_path, use_tpb=int(tpb), annotation_range=annotation_range)
    if track_idx < 0 or track_idx >= len(df_ls):
        raise ValueError(f"track_idx 超出范围: {track_idx} (0..{len(df_ls)-1})")

    notes = df_ls[track_idx]
    stride = stride_ticks(ssm_beat_stride, tpb)
    if len(notes) and (max_frames is not None or max_roll_cells is not None):
        ticks = int(notes.off.max()) + 1
        pitches = int(notes.pitch.max()) - int(notes.pitch.min()) + 1
        frames = ticks // stride
        if max_frames is not None and frames > max_frames:
            raise MatrixSizeError(ticks, pitches, frames, max_frames)
        if max_roll_cells is not None and pitches * ticks > max_roll_cells:
            raise ValueError("钢琴卷帘过大，请减少每拍刻度或选择较短的音轨。")

    pr, pitch_start, _ = DF2PR(
        df_ls[int(track_idx)],
        on_weight=float(note_on_weight),
        dur_weight=float(dur_weight),
        keep_time_origin=True,
        return_crop_info=True,
    )
    if annotation_range is not None:
        pr = pr[:, :-1]

    # 与 ssm.py 原 __main__ 逻辑保持一致：
    # 1) 先在未滤波 ssm 上找 diag_lines（查找范围固定为 find_range）
    # 2) 再过滤 ssm
    # 3) 在滤波后 ssm 上找 diag_lines_f（显示范围使用 ssm_disp_range_tick）

    matrix_input = pr
    if annotation_range is not None and 0 < pr.shape[1] < stride:
        matrix_input = np.pad(pr, ((0, 0), (0, stride - pr.shape[1])))
    ssm_raw, stride_tick = compute_ssm(
        matrix_input,
        ssm_beat_stride=float(ssm_beat_stride),
        use_tpb=int(tpb),
        ssm_mode=str(ssm_mode),
        sigma=float(sigma),
        blur_size=blur_size,
        blur_sigma=blur_sigma,
        note_on_weight=note_on_weight,
    )

    if not ssm_raw.size:
        raise ValueError("音轨长度不足一个分析步长。")
    if matrix_input is not pr:
        stride_tick = pr.shape[1]

    min_len = max(2, ceil(min_line_beat_len * tpb / stride_tick))
    ssm_find_range = (0, int(ssm_find_range_in_stride_tick) * int(stride_tick))

    diag_lines = find_ssm_diag_lines(
        ssm_raw,
        stride_tick=int(stride_tick),
        tick_offset=0,
        ssm_disp_range=ssm_find_range,
        thr=0.0,
        min_len=int(min_len),
    ) if include_raw_lines else []
    diag_hlines, merged_info = layout_diag_lines(diag_lines)

    ssm_f = ssm_filter(ssm_raw, thr=float(filter_thr))

    diag_lines_f = find_ssm_diag_lines(
        ssm_f,
        stride_tick=int(stride_tick),
        tick_offset=0,
        ssm_disp_range=ssm_disp_range_tick,
        thr=0.0,
        min_len=int(min_len),
    )
    split_sources = []
    if split_overlaps:
        diag_lines_f, split_sources = split_overlapping_diagonals(
            diag_lines_f, stride_tick, min_length_tick=split_min_beats * tpb,
        )
    short_lines = []
    if include_short_lines and min_len > 2:
        short_lines = [
            line for line in find_ssm_diag_lines(ssm_f, stride_tick, ssm_disp_range=ssm_disp_range_tick)
            if line[0] != line[2] and line[1] - line[0] < (min_len - 1) * stride_tick
        ]
    rectangles = []
    if rectangle_min_beats is not None:
        rectangles = find_ssm_rectangles(ssm_f, stride_tick, rectangle_min_beats * tpb)
    removed_line_count = 0
    rectangle_removed_counts = []
    if remove_self_similarity and rectangles:
        count_before = len(diag_lines_f) + len(short_lines)
        kept, rectangle_removed_counts = remove_redundant_ssm_diagonals(
            [line for line in diag_lines_f if line[0] != line[2]] + short_lines,
            rectangles, stride_tick,
        )
        diag_lines_f = [line for line in diag_lines_f if line[0] == line[2] or line in kept]
        short_lines = [line for line in short_lines if line in kept]
        split_sources = [(piece, source) for piece, source in split_sources if piece in kept]
        removed_line_count = count_before - len(diag_lines_f) - len(short_lines)
    if max_structure_lines is not None and sum(x0 != y0 for x0, _, y0, _ in diag_lines_f) > max_structure_lines:
        raise ValueError(f"匹配线段超过 {max_structure_lines} 条，请提高阈值或最短匹配长度。")

    midi_name = Path(midi_path).stem
    midi_tick_end = int(pr.shape[1])
    diag_hlines_f, merged_info_f = layout_diag_lines(
        diag_lines_f, frame_width=stride_tick,
        singleton_width=stride_tick if split_overlaps else 0,
    )
    tree_root, merged_sim = build_hline_tree(
        diag_hlines_f=diag_hlines_f,
        merged_info_f=merged_info_f,
        midi_name=midi_name,
        midi_tick_end=midi_tick_end,
        pr=pr,
        unique_min_len_tick=int(4 * int(tpb)) if unique_min_len_tick is None else int(unique_min_len_tick),
        fill_min_len_tick=int(4 * int(tpb)) if fill_min_len_tick is None else int(fill_min_len_tick),
        overlap_policy=str(tree_overlap_policy),
        parent_edge_tolerance_tick=parent_edge_tolerance_beats * tpb,
    )

    nodes = [tree_root, *tree_root.descendants]
    leaves = [node for node in nodes if node.is_leaf and getattr(node, "leaf_class", node.shape_class) != "root"]

    leaf_items = []
    for n in leaves:
        s = int(round(float(getattr(n, "start", 0.0))))
        e = int(round(float(getattr(n, "end", 0.0))))
        s = max(0, min(s, pr.shape[1]))
        e = max(0, min(e, pr.shape[1]))
        if e <= s:
            continue
        mat = pr[:, s:e].copy() if copy_leaf_matrices else pr[:, s:e]
        leaf_items.append(
            {
                "matrix": mat,
                "meta": {
                    "file": str(midi_path),
                    "track_idx": int(track_idx),
                    "class_name": getattr(n, "leaf_class", n.shape_class),
                    "tick_start": int(s),
                    "tick_end": int(e),
                    "node_name": str(getattr(n, "name", "")),
                },
            }
        )

    if plot_pr is None:
        plot_pr = bool(plot)
    if plot_ssm is None:
        plot_ssm = bool(plot)
    if plot_tree is None:
        plot_tree = bool(plot)
    if plot_tree_midi_slices is None:
        plot_tree_midi_slices = bool(plot)
    if plot_leaves is None:
        plot_leaves = bool(plot)

    if any((plot_pr, plot_ssm, plot_tree, plot_tree_midi_slices, plot_leaves)):
        from plots import (plot_anytree, plot_similarity_classes_stacked,
                           plot_tree_with_midi_slices_anytree, show_pr, show_ssm_with_pr)

    if plot_pr:
        show_pr(pr, title=f"PR - {midi_name}", show=True, tpb=int(tpb))

    if plot_ssm:
        show_ssm_with_pr(
            pr,
            ssm_f,
            int(stride_tick),
            title=f"SSM (filtered thr={float(filter_thr)}) - {midi_name}",
            ssm_disp_range=ssm_disp_range_tick,
            diag_lines=diag_lines,
            diag_hlines=diag_hlines,
            show=True,
        )

    if plot_tree:
        plot_anytree(tree_root, show=True)

    if plot_tree_midi_slices:
        plot_tree_with_midi_slices_anytree(tree_root, pr, midi_tick_end=midi_tick_end, show=True)

    if plot_leaves:
        plot_similarity_classes_stacked(pr=pr, tree_root=tree_root, midi_tick_end=midi_tick_end, show=True)

    unique_nodes = [node for node in nodes if getattr(node, "leaf_class", node.shape_class) == "unique"]
    unique_segments = [
        (int(round(float(getattr(n, "start", 0.0)))), int(round(float(getattr(n, "end", 0.0)))))
        for n in unique_nodes
    ]

    return {
        "pr": pr,
        "ssm": ssm_f,
        "ssm_raw": ssm_raw,
        "diag_lines_filtered": diag_lines_f,
        "short_lines": short_lines,
        "rectangles": rectangles,
        "rectangle_removed_counts": rectangle_removed_counts,
        "removed_line_count": removed_line_count,
        "split_sources": split_sources,
        "pitch_start": pitch_start,
        "notes": notes,
        "stride_tick": int(stride_tick),
        "diag_lines": diag_lines,
        "diag_hlines": diag_hlines,
        "merged_info": merged_info,
        "merged_sim": merged_sim,
        "tree_root": tree_root,
        "leaf_items": leaf_items,
        "unique_nodes": unique_nodes,
        "unique_segments": unique_segments,
        "meta": {"file": str(midi_path), "track_idx": int(track_idx), "tpb": int(tpb), **(meta or {})},
    }


if __name__ == "__main__":
    from ssm_pipeline_test import main
    main()
