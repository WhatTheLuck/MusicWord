"""Command-line entry point for active-basis experiments on POP909."""

import argparse
import csv
from dataclasses import asdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def seed_value(value):
    number = int(value)
    if not 0 <= number < 2**32:
        raise argparse.ArgumentTypeError("must be between 0 and 4294967295")
    return number


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Learn sparse musical patterns from labeled POP909 tracks.")
    parser.add_argument("--pop909-dir", type=Path, default=ROOT / "POP909-Dataset" / "POP909")
    parser.add_argument("--label-dir", type=Path, default=ROOT / "labeled data",
                        help="Directory containing T_dict/")
    parser.add_argument("--song-ids", type=positive_int, nargs="+", default=[2])
    parser.add_argument("--track-number", type=int, choices=(1, 2), default=1,
                        help="MIDI track index (1=melody, 2=bridge), with annotation suffix one lower")
    parser.add_argument("--rounds", type=positive_int, default=10)
    parser.add_argument("--seed", type=seed_value, default=37)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "results" / "simple_sparse_code")
    parser.add_argument("--plot-metrics", action="store_true", help="Show metric curves after training")
    parser.add_argument("--visualize", action="store_true", help="Export a self-contained training Playback.html")
    return parser.parse_args(argv)


def create_run_directory(root):
    root.mkdir(parents=True, exist_ok=True)
    number = max((int(path.name) for path in root.iterdir() if path.name.isdecimal()), default=0) + 1
    while True:
        directory = root / str(number)
        try:
            directory.mkdir()
        except FileExistsError:
            number += 1
        else:
            return directory


def plot_metrics(history, names):
    import matplotlib.pyplot as plt

    figure, axis = plt.subplots(figsize=(10, 5))
    rounds = range(1, len(history) + 1)
    columns = list(zip(*history))
    for name, values in zip(names[:-1], columns[:-1]):
        axis.plot(rounds, values, marker="o", label=name)
    axis.set(xlabel="Round", ylabel="Scores")
    axis.legend(loc="upper left")
    error_axis = axis.twinx()
    error_axis.plot(rounds, columns[-1], color="black", linestyle="--", marker="x", label=names[-1])
    error_axis.set_ylabel(names[-1])
    error_axis.legend(loc="upper right")
    figure.tight_layout()
    plt.show()


def run(args):
    import numpy as np

    from active_basis import LearningConfig, encode, prepare_dictionary, relearn
    from song_data import METRIC_NAMES, MINIMUM_PITCH_RANGE, TICKS_PER_BEAT, evaluate, load_song

    config = LearningConfig()
    pop909 = args.pop909_dir.expanduser().resolve()
    labels = args.label_dir.expanduser().resolve() / "T_dict"
    inputs = [
        (pop909 / f"{song_id:03d}" / f"{song_id:03d}.mid", labels / f"{song_id}-{args.track_number - 1}.pkl")
        for song_id in args.song_ids
    ]
    missing = [str(path) for paths in inputs for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing input files:\n  " + "\n  ".join(missing))
    songs = [load_song(midi, label, args.track_number, config.blur_size) for midi, label in inputs]
    rolls = [song.roll for song in songs]

    output = create_run_directory(args.output_dir.expanduser().resolve())
    parameters = vars(args) | {
        "pop909_dir": pop909, "label_dir": labels.parent, "ticks_per_beat": TICKS_PER_BEAT,
    } | asdict(config)
    with (output / "Parameters.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("Variable", "Value"))
        writer.writerows(parameters.items())

    rng = np.random.RandomState(args.seed)
    dictionary = [None] * config.initial_templates
    history = []
    observer = None
    if args.visualize:
        from playback import PlaybackRecorder

        observer = PlaybackRecorder(args.song_ids, args.track_number, args.seed, songs, config,
                                    resolution=TICKS_PER_BEAT)
        observer.data["minimumPitchRange"] = MINIMUM_PITCH_RANGE
    print(f"Output: {output}", flush=True)
    with (output / "Metrics.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(("Round", *METRIC_NAMES))
        for index in range(args.rounds):
            if None not in dictionary:
                dictionary.extend([None] * config.dictionary_growth)
            if observer is not None:
                observer.start_round()
            variants = prepare_dictionary(dictionary, rolls, rng, config, observer)
            if observer is not None:
                observer.prepared(dictionary, variants)
            matches, reconstructions = encode(rolls, variants, config, observer)
            scores = evaluate(songs, matches, reconstructions)
            history.append(scores)
            writer.writerow((index, *scores))
            stream.flush()
            print(
                f"Round {index + 1}/{args.rounds} | "
                f"templates {sum(template is not None for template in dictionary)}/{len(dictionary)} | "
                f"matches {sum(map(len, matches))} | IoU {scores[0]:.4f} | RMSE {scores[-1]:.4f}",
                flush=True,
            )
            if index + 1 < args.rounds or observer is not None:
                dictionary = relearn(rolls, matches, len(dictionary), config, observer)

    if observer is not None:
        report = output / "Playback.html"
        observer.write(report, METRIC_NAMES, history)
        print(f"Playback: {report}", flush=True)
    if args.plot_metrics:
        plot_metrics(history, METRIC_NAMES)
    return output


if __name__ == "__main__":
    run(parse_args())
