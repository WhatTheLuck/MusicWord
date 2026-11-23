"""Export the trusted Texton annotation sources for the static workbench."""

import argparse
import csv
import json
from pathlib import Path
import re

from song_data import LabelUnpickler, load_track
from workbench import catalog


OUTPUT = Path(__file__).resolve().parent / "web" / "public" / "annotations"


def note(row):
    pitch, start, end = (int(row[key]) for key in ("pitch", "note_on_tick", "note_off_tick"))
    if not (0 <= pitch <= 127 and 0 <= start <= end):
        raise ValueError(f"Invalid MIDI note: {pitch}, {start}, {end}")
    return [pitch, start, end]


def dictionary_instances(path):
    with path.open("rb") as stream:
        groups = LabelUnpickler(stream).load()
    return [
        {"group": str(group), "id": str(template.uid),
         "notes": sorted((note(row) for row in template.template_df.to_dict("records")), key=lambda n: n[1])}
        for group, templates in sorted(groups.items())
        for template in templates
        if not template.template_df.empty
    ]


def csv_track(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = [key for key in reader.fieldnames if key.startswith("TemplateType")]
        notes = []
        instances = {}
        for row in reader:
            current = note(row)
            notes.append(current)
            for field in fields:
                category = (row[field] or "").strip()
                ident = (row["TemplateID"] or "").strip()
                if not category or not ident:
                    continue
                group = f"{field[-1]}层 · {category}" if len(fields) > 1 else category
                instance = instances.setdefault((group, ident), {"group": group, "id": ident, "notes": []})
                instance["notes"].append(current)
    return {"source": path.name, "notes": notes, "instances": list(instances.values())}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def export(source, midi_root):
    tracks = {}
    for directory, extension in (("T_dict", "pkl"), ("Labeled Songs", "csv")):
        for path in (source / directory).glob(f"*.{extension}"):
            if match := re.fullmatch(r"(\d+)-(\d+)", path.stem):
                song, track = map(int, match.groups())
                tracks.setdefault((f"{song:03d}", track), {})[extension] = path
    if not tracks:
        raise ValueError(f"No annotation tracks in {source}")

    names = {song["id"]: song["name"] for song in catalog(midi_root)}
    songs = {}
    packets = {}
    for (song, track), paths in sorted(tracks.items()):
        resolution, pitches, starts, ends = load_track(midi_root / song / f"{song}.mid", track + 1)
        versions = {}
        if "pkl" in paths:
            versions["dictionary"] = {
                "source": paths["pkl"].name,
                "notes": [[int(p), int(s), int(e)] for p, s, e in zip(pitches, starts, ends)],
                "instances": dictionary_instances(paths["pkl"]),
            }
        if "csv" in paths:
            versions["csv"] = csv_track(paths["csv"])
        key = f"{song}-{track}"
        packets[key] = {"resolution": resolution, "versions": versions}
        entry = songs.setdefault(song, {"id": song, "name": names.get(song, song), "tracks": []})
        entry["tracks"].append({"id": track, "key": key})

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for key, packet in packets.items():
        write_json(OUTPUT / f"{key}.json", packet)
    write_json(OUTPUT / "index.json", list(songs.values()))
    print(f"{len(songs)} songs, {len(packets)} tracks, "
          f"{sum(len(packet['versions']) for packet in packets.values())} source files")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Trusted directory containing T_dict and Labeled Songs")
    parser.add_argument("--midi-root", type=Path, help="POP909 directory containing the original MIDI files")
    args = parser.parse_args()
    export(args.source, args.midi_root or args.source.parent / "POP909")
