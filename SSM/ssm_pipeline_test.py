import argparse
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_MIDI_PATH = (
    PROJECT_ROOT / "examples" / "Fr_Elise.mid"
)

# 可选：你也可以把这些参数都放在这里统一管理
PARAMS = dict(
    note_on_weight=1.0,
    dur_weight=0.2,
    ssm_beat_stride=1.0,
    ssm_mode="NCC",
    sigma=1.0,
    filter_thr=0.6,
    min_line_beat_len=6,
    ssm_disp_range_tick=None,
    ssm_find_range_in_stride_tick=120,
    tree_overlap_policy="keep",
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run piano-roll, SSM, and hierarchical pattern analysis on one MIDI track."
    )
    parser.add_argument(
        "--midi",
        type=Path,
        default=DEFAULT_MIDI_PATH,
        help=f"MIDI file path (default: {DEFAULT_MIDI_PATH})",
    )
    parser.add_argument("--track-idx", type=int, default=0, help="Track index to analyze (default: 0)")
    parser.add_argument("--tpb", type=int, default=12, help="Quantized ticks per beat (default: 12)")
    parser.add_argument("--mode", choices=("NCC", "SAD", "TEXTON"), default=PARAMS["ssm_mode"])
    parser.add_argument("--stride", type=float, default=PARAMS["ssm_beat_stride"])
    parser.add_argument("--filter-thr", type=float, default=PARAMS["filter_thr"])
    parser.add_argument("--min-line-beat-len", type=int, default=PARAMS["min_line_beat_len"])
    parser.add_argument(
        "--find-range-stride-tick",
        type=int,
        default=PARAMS["ssm_find_range_in_stride_tick"],
        help="SSM diagonal search range (default: 120)",
    )
    parser.add_argument(
        "--plot",
        action="store_true",
        help="Display PR, SSM, tree, and pattern-class plots",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    midi_path = args.midi.expanduser().resolve()
    if not midi_path.is_file():
        raise FileNotFoundError(
            f"MIDI file not found: {midi_path}\n"
            "Download the dataset as described in README.md or pass --midi."
        )

    import ssm

    params = dict(PARAMS)
    params.update(
        ssm_mode=args.mode,
        ssm_beat_stride=args.stride,
        filter_thr=args.filter_thr,
        min_line_beat_len=args.min_line_beat_len,
        ssm_find_range_in_stride_tick=args.find_range_stride_tick,
    )

    out = ssm.run_singletrack_ssm_pipeline(
        midi_path=str(midi_path),
        track_idx=args.track_idx,
        tpb=args.tpb,
        plot=args.plot,
        **params,
    )

    print("midi:", midi_path)
    print("pr shape:", out["pr"].shape)
    print("ssm shape:", out["ssm"].shape, "stride_tick:", out["stride_tick"])
    print("diag_lines:", len(out["diag_lines"]), "diag_hlines:", len(out["diag_hlines"]))
    print("tree leaves:", len(out["leaf_items"]))


if __name__ == "__main__":
    main()
