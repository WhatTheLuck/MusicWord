"""Analyze a MIDI folder and write per-track patterns and an aggregate dictionary."""
import argparse
import gc
from pathlib import Path
import pickle
import re
from datetime import datetime

from ssm import run_singletrack_ssm_pipeline

PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = PROJECT_ROOT / "examples"
OUTPUT_ROOT = PROJECT_ROOT / "output"
TRACK_IDX = 0
TPB = 12
PARAMS = dict(note_on_weight=1.0, dur_weight=0.2, ssm_beat_stride=1.0, ssm_mode="NCC",
              sigma=1.0, filter_thr=0.3, min_line_beat_len=4, ssm_disp_range_tick=None,
              ssm_find_range_in_stride_tick=1_000_000, tree_overlap_policy="keep")
UNIQUE_MIN_BEAT_LEN = 4
SAVE_FIG = True
SILENT = False
GC_EVERY_N = 5


def write_pickle(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as file:
        pickle.dump(obj, file, protocol=pickle.HIGHEST_PROTOCOL)


def safe_name(name):
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def batch_process(*, data_dir=DATA_DIR, output_root=OUTPUT_ROOT, track_idx=TRACK_IDX,
                  tpb=TPB, params=None, unique_min_beat_len=UNIQUE_MIN_BEAT_LEN,
                  save_fig=SAVE_FIG, silent=SILENT, gc_every_n=GC_EVERY_N, limit=None):
    data_dir = Path(data_dir).expanduser().resolve()
    params = PARAMS | (params or {})
    midi_files = sorted(path for path in data_dir.rglob("*")
                        if path.is_file() and path.suffix.lower() in {".mid", ".midi"})
    if limit is not None:
        if limit < 1:
            raise ValueError("--limit must be at least 1")
        midi_files = midi_files[:limit]
    if not midi_files:
        raise ValueError(f"No MIDI files found in: {data_dir}")

    if save_fig:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from plots import plot_tree_with_midi_slices_anytree

    time_tag = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    exp_tag = (f"{time_tag}_tpb{tpb}_stride{params['ssm_beat_stride']}"
               f"_thr{params['filter_thr']}_minlen{params['min_line_beat_len']}"
               f"_uniq{unique_min_beat_len}b")
    out_root = Path(output_root).expanduser().resolve() / exp_tag
    write_pickle(out_root / "params.pkl", dict(time=exp_tag, data_dir=str(data_dir), tpb=tpb,
                 track_idx=track_idx, params=params, unique_min_beat_len=unique_min_beat_len, limit=limit))
    all_patterns = {}
    processed = 0
    errors = []
    claimed = set()

    for index, midi_path in enumerate(midi_files, 1):
        midi_name = safe_name(midi_path.stem)
        if not silent:
            print(f"[{index}/{len(midi_files)}] {midi_name}")
        relative = midi_path.relative_to(data_dir)
        folder = Path(*(safe_name(part) for part in relative.parent.parts))
        result_name = folder / midi_name
        while str(result_name).casefold() in claimed:
            result_name = result_name.with_name(result_name.name + "_")
        claimed.add(str(result_name).casefold())
        result = None
        try:
            result = run_singletrack_ssm_pipeline(
                midi_path=str(midi_path), track_idx=track_idx, tpb=tpb, plot=False,
                unique_min_len_tick=unique_min_beat_len * tpb,
                fill_min_len_tick=unique_min_beat_len * tpb,
                include_raw_lines=False, **params,
            )
            if save_fig:
                plot_tree_with_midi_slices_anytree(
                    result["tree_root"], result["pr"], midi_tick_end=result["pr"].shape[1], show=False,
                )
                image = out_root / "fig" / result_name.parent / (result_name.name + "_tree_slices.png")
                image.parent.mkdir(parents=True, exist_ok=True)
                plt.gcf().savefig(image, dpi=150, bbox_inches="tight")
            record = dict(midi_path=str(midi_path), midi_name=midi_name, tpb=tpb, track_idx=track_idx,
                          params=params, unique_min_beat_len=unique_min_beat_len,
                          leaf_items=result["leaf_items"], tree_root=result["tree_root"], meta=result["meta"])
            write_pickle(out_root / "pattern" / result_name.parent / (result_name.name + ".pkl"), record)
            for item in result["leaf_items"]:
                all_patterns.setdefault(item["meta"]["class_name"], []).append(item)
            processed += 1
        except Exception as error:
            errors.append(f"{midi_name}\t{midi_path}\t{error!r}\n")
        finally:
            if save_fig:
                plt.close("all")
            result = None
            if gc_every_n and index % gc_every_n == 0:
                gc.collect()

    if errors:
        (out_root / "errors.txt").write_text("".join(errors), encoding="utf-8")
    write_pickle(out_root / "all_patterns.pkl", dict(exp=exp_tag, out_root=str(out_root),
                 processed=processed, total=len(midi_files), all_patterns=all_patterns))
    print(f"{processed}/{len(midi_files)} processed -> {out_root}")
    return out_root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_ROOT)
    parser.add_argument("--track-idx", type=int, default=TRACK_IDX)
    parser.add_argument("--tpb", type=int, default=TPB)
    parser.add_argument("--mode", choices=("NCC", "SAD", "TEXTON"), default="NCC")
    parser.add_argument("--stride", type=float, default=PARAMS["ssm_beat_stride"])
    parser.add_argument("--filter-thr", type=float, default=PARAMS["filter_thr"])
    parser.add_argument("--min-line-beat-len", type=int, default=PARAMS["min_line_beat_len"])
    parser.add_argument("--find-range-stride-tick", type=int, default=PARAMS["ssm_find_range_in_stride_tick"])
    parser.add_argument("--unique-min-beat-len", type=int, default=UNIQUE_MIN_BEAT_LEN)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--no-fig", action="store_true")
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--gc-every", type=int, default=GC_EVERY_N)
    args = parser.parse_args()
    batch_process(
        data_dir=args.data_dir, output_root=args.output_dir, track_idx=args.track_idx,
        tpb=args.tpb, params=dict(ssm_mode=args.mode, ssm_beat_stride=args.stride,
        filter_thr=args.filter_thr, min_line_beat_len=args.min_line_beat_len,
        ssm_find_range_in_stride_tick=args.find_range_stride_tick),
        unique_min_beat_len=args.unique_min_beat_len, save_fig=not args.no_fig,
        silent=args.silent, gc_every_n=args.gc_every, limit=args.limit,
    )


if __name__ == "__main__":
    main()
