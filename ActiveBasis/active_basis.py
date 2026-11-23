"""Active-basis dictionary learning on weighted piano rolls."""

from dataclasses import dataclass

import numpy as np
from scipy import signal


ONSET = 1.0
SUSTAIN = 0.01


@dataclass(frozen=True)
class LearningConfig:
    initial_templates: int = 4
    dictionary_growth: int = 3
    initial_shape: tuple[int, int] = (10, 20)
    initial_note_count: tuple[int, int] = (5, 10)
    initial_duration: tuple[int, int] = (1, 20)
    pitch_scales: tuple[float, ...] = (1.0, 0.8, 1.2)
    blur_size: int = 5
    random_sigma: float = 1.25
    learned_sigma: float = 1.0
    uniqueness_threshold: float = 0.8
    usefulness_threshold: float = 0.3
    max_template_attempts: int = 200
    response_threshold: float = 0.2
    note_penalty: float = 0.018
    learned_penalty: float = 0.25
    repulsion: float = 0.6
    capture_margin: int = 10
    minimum_captures: int = 4
    merge_threshold: float = 0.8
    spawn_blur_size: int = 3
    spawn_sigma: float = 1.0
    spawn_ratio: float = 0.5
    minimum_learned_notes: int = 3
    maximum_learned_notes: int = 8
    reference_blur_size: int = 5
    reference_sigma: float = 2.0
    capture_pitch_margin: int | None = None
    capture_time_margin: int | None = None


@dataclass(frozen=True)
class Basis:
    pitch: int
    tick: int
    duration: int


@dataclass
class Template:
    notes: list[Basis]
    matrix: np.ndarray
    learned: bool = False


@dataclass
class Variant:
    template_id: int
    pitch_scale: float
    matrix: np.ndarray
    blurred: np.ndarray
    normalization: float
    responses: dict[int, np.ndarray]


@dataclass(frozen=True)
class Match:
    box: tuple[int, int, int, int]
    template_id: int
    pitch_scale: float


def render_notes(notes, shape=None):
    if shape is None:
        shape = (
            max(note.pitch for note in notes) + 1,
            max(note.tick + note.duration for note in notes) + 1,
        )
    matrix = np.zeros(shape)
    for note in notes:
        matrix[note.pitch, note.tick] = ONSET
        matrix[note.pitch, note.tick + 1:note.tick + note.duration] = SUSTAIN
    return matrix


def blur(matrix, size, sigma, mode="full"):
    if size == 1:
        return matrix.copy()
    window = signal.windows.gaussian(size, std=sigma)
    kernel = np.outer(window, window)
    kernel /= kernel.max()
    return signal.correlate(matrix, kernel, mode=mode, method="direct")


def maximum_zncc(matrix, kernel):
    """Maximum absolute zero-mean normalized cross-correlation over full overlap."""
    padded = np.pad(matrix, [(size - 1, size - 1) for size in kernel.shape])
    centered_kernel = kernel - kernel.mean()
    kernel_energy = np.sum(centered_kernel ** 2)
    if kernel_energy == 0:
        return 0.0

    height, width = kernel.shape

    def window_sums(values):
        integral = np.pad(values, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        return (
            integral[height:, width:] - integral[:-height, width:]
            - integral[height:, :-width] + integral[:-height, :-width]
        )

    sums = window_sums(padded)
    energy = window_sums(padded ** 2) - sums ** 2 / kernel.size
    covariance = signal.correlate(padded, centered_kernel, mode="valid", method="fft")
    tolerance = np.finfo(float).eps * np.sum(padded ** 2) * 16
    valid = energy > tolerance
    if not valid.any():
        return 0.0
    correlations = np.abs(covariance[valid]) / np.sqrt(energy[valid] * kernel_energy)
    return min(float(correlations.max()), 1.0)


def random_template(rng, config):
    count = rng.randint(*config.initial_note_count)
    ticks = rng.randint(config.initial_shape[1], size=count)
    pitches = rng.randint(config.initial_shape[0], size=count)
    durations = rng.randint(*config.initial_duration, size=count)
    notes = [
        Basis(int(pitch), int(tick), int(duration))
        for pitch, tick, duration in zip(
            pitches - pitches.min(), ticks - ticks.min(), durations - durations.min()
        )
    ]
    return Template(notes, render_notes(notes, config.initial_shape))


def scale_notes(notes, pitch_scale):
    return [Basis(round(note.pitch * pitch_scale), note.tick, note.duration) for note in notes]


def prepare_variants(template_id, template, rolls, config):
    sigma = config.learned_sigma if template.learned else config.random_sigma
    penalty = len(template.notes) * config.note_penalty
    if template.learned:
        penalty += config.learned_penalty

    variants = []
    for pitch_scale in config.pitch_scales:
        matrix = render_notes(scale_notes(template.notes, pitch_scale))
        blurred = blur(matrix, config.blur_size, sigma)
        normalization = float(np.sum(blur(matrix, config.blur_size, sigma, "same") * matrix))
        responses = {
            index: signal.correlate(roll, blurred, mode="valid") / normalization - penalty
            for index, roll in enumerate(rolls)
            if all(size >= needed for size, needed in zip(roll.shape, blurred.shape))
        }
        if responses:
            variants.append(Variant(template_id, pitch_scale, matrix, blurred, normalization, responses))
    return variants


def prepare_dictionary(dictionary, rolls, rng, config, observer=None):
    """Fill vacant slots with dissimilar templates that respond to the input."""
    variants = []
    # The legacy uniqueness check pads both axes by the blurred template height minus one.
    blur_border = config.initial_shape[0] + config.blur_size - 2
    for template_id, template in enumerate(dictionary):
        if template is not None:
            candidates = prepare_variants(template_id, template, rolls, config)
            score = best_response(candidates)
            if observer is not None:
                observer.trial(template_id, template, score, config.usefulness_threshold)
            if score >= config.usefulness_threshold:
                variants.extend(candidates)
                continue
            dictionary[template_id] = None

        references = [(index, existing) for index, existing in enumerate(dictionary) if existing is not None]
        comparisons = [
            (index, blur(np.pad(existing.matrix, blur_border), config.reference_blur_size, config.reference_sigma))
            for index, existing in references
        ]
        if observer is not None:
            observer.trial_references(template_id, references)
        for _ in range(config.max_template_attempts):
            candidate = random_template(rng, config)
            blurred = blur(candidate.matrix, config.blur_size, config.random_sigma)
            scores = ((index, maximum_zncc(matrix, blurred)) for index, matrix in comparisons)
            recorded_scores = list(scores) if observer is not None else None
            similar = next((score for _, score in (recorded_scores if recorded_scores is not None else scores)
                            if score > config.uniqueness_threshold), None)
            if similar is not None:
                if observer is not None:
                    observer.trial(template_id, candidate, similarity=similar, comparisons=recorded_scores)
                continue
            candidates = prepare_variants(template_id, candidate, rolls, config)
            score = best_response(candidates)
            if observer is not None:
                observer.trial(template_id, candidate, score, config.usefulness_threshold, comparisons=recorded_scores)
            if score >= config.usefulness_threshold:
                dictionary[template_id] = candidate
                variants.extend(candidates)
                break
    return variants


def best_response(variants):
    return max(
        (response.max() for variant in variants for response in variant.responses.values()),
        default=-np.inf,
    )


def encode(rolls, variants, config, observer=None):
    """Greedily match variants and refresh the affected columns of the response maps."""
    residuals = [roll.copy() for roll in rolls]
    reconstructions = [np.zeros_like(roll) for roll in rolls]
    matches = [[] for _ in rolls]
    response_maps = [
        (variant, song_index, response)
        for variant in variants for song_index, response in variant.responses.items()
    ]
    while response_maps:
        variant, song_index, response = max(response_maps, key=lambda entry: entry[2].max())
        pitch, tick = np.unravel_index(response.argmax(), response.shape)
        score = response[pitch, tick]
        if score < config.response_threshold:
            break
        if observer is not None:
            observer.ranking([
                (other.template_id, other.pitch_scale, float(values.max()))
                for other, index, values in response_maps if index == song_index
            ])

        height, width = variant.blurred.shape
        residual = residuals[song_index]
        region = residual[pitch:pitch + height, tick:tick + width]
        np.maximum(region - variant.blurred, 0, out=region)
        raw_height, raw_width = variant.matrix.shape
        reconstructions[song_index][pitch:pitch + raw_height, tick:tick + raw_width] += variant.matrix
        match = Match((tick, pitch, tick + width, pitch + height), variant.template_id, variant.pitch_scale)
        matches[song_index].append(match)

        for other in variants:
            if song_index not in other.responses:
                continue
            other_response = other.responses[song_index]
            other_width = other.blurred.shape[1]
            left = max(tick - other_width + 1, 0)
            right = min(tick + width, other_response.shape[1])
            window = residual[:, left:right + other_width - 1]
            updated = signal.correlate(window, other.blurred, mode="valid")
            updated = updated / other.normalization - config.repulsion
            if observer is not None and other is variant:
                observer.match(song_index, match, score, left, other_response[:, left:right], updated)
            other_response[:, left:right] = updated
    return matches, reconstructions


def capture_patches(rolls, matches, dictionary_size, margin, observer=None, *, pitch_margin=None, time_margin=None):
    pitch_margin = margin if pitch_margin is None else pitch_margin
    time_margin = margin if time_margin is None else time_margin
    datasets = [[] for _ in range(dictionary_size)]
    for song_index, (roll, song_matches) in enumerate(zip(rolls, matches)):
        for match_index, match in enumerate(song_matches):
            left, bottom, right, top = match.box
            left = max(left - time_margin, 0)
            bottom = max(bottom - pitch_margin, 0)
            patch = roll[bottom:top + pitch_margin, left:right + time_margin]
            notes = []
            for pitch, tick in np.argwhere(patch == ONSET):
                # The original capture stage counts consecutive sustain cells after the onset.
                duration = 0
                for cell in patch[pitch, tick + 1:]:
                    if cell != SUSTAIN:
                        break
                    duration += 1
                notes.append(Basis(int(pitch), int(tick), duration))
            if notes:
                restored = render_notes(scale_notes(notes, 1 / match.pitch_scale))
                datasets[match.template_id].append(restored)
                if observer is not None:
                    observer.capture(song_index, match_index, patch, restored, len(datasets[match.template_id]))
    return datasets


def spawn_map(patches, config):
    height = max(patch.shape[0] for patch in patches)
    width = max(patch.shape[1] for patch in patches)
    average = np.zeros((height, width))
    for patch in patches:
        average[:patch.shape[0], :patch.shape[1]] += patch
    average /= len(patches)
    return blur(average, config.spawn_blur_size, config.spawn_sigma, "same")


def learn_template(density, config, on_basis=None):
    peak = density.max()
    if peak <= 0:
        return None

    remaining = density
    notes = []
    for _ in range(config.maximum_learned_notes):
        pitch, tick = np.unravel_index(remaining.argmax(), remaining.shape)
        if remaining[pitch, tick] < peak * config.spawn_ratio:
            break
        duration = 0
        for cell in remaining[pitch, tick + 1:]:
            if not peak * SUSTAIN * config.spawn_ratio < cell < peak * config.spawn_ratio:
                break
            duration += 1
        notes.append(Basis(int(pitch), int(tick), duration))
        painted = render_notes(notes, density.shape)
        remaining = density - blur(painted, config.spawn_blur_size, config.spawn_sigma, "same")
        if on_basis is not None:
            on_basis(notes[-1], len(notes), painted, remaining)

    if len(notes) < config.minimum_learned_notes:
        return None
    pitch_origin = min(note.pitch for note in notes)
    tick_origin = min(note.tick for note in notes)
    normalized = [
        Basis(note.pitch - pitch_origin, note.tick - tick_origin, note.duration) for note in notes
    ]
    return Template(normalized, render_notes(normalized), learned=True)


def relearn(rolls, matches, dictionary_size, config, observer=None):
    datasets = capture_patches(
        rolls, matches, dictionary_size, config.capture_margin, observer,
        pitch_margin=config.capture_pitch_margin, time_margin=config.capture_time_margin,
    )
    densities = {}
    for index, patches in enumerate(datasets):
        if len(patches) < config.minimum_captures:
            if observer is not None:
                observer.density(index, len(patches))
            continue
        density = spawn_map(patches, config)
        if observer is not None:
            observer.density(index, len(patches), density)
        for previous, previous_density in list(densities.items()):
            similarity = maximum_zncc(previous_density, density)
            if similarity > config.merge_threshold:
                patches.extend(datasets[previous])
                del densities[previous]
                if observer is not None:
                    observer.merge(
                        index, previous, len(patches), similarity,
                        previous_density, density, spawn_map(patches, config),
                    )
        densities[index] = spawn_map(patches, config)

    dictionary = [None] * dictionary_size
    for index, density in densities.items():
        on_basis = None if observer is None else observer.basis_recorder(index, density)
        dictionary[index] = learn_template(density, config, on_basis)
        if observer is not None:
            observer.learned(index, dictionary[index])
    return dictionary
