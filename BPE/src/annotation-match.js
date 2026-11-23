export const DEFAULT_MATCH_PARAMETERS = {
  threshold: 85, onsetTolerance: 0.125, durationTolerance: 35,
  transpose: 0, tempoTolerance: 10, maxResults: 100, skipAnnotated: true,
};

const ordered = (notes) => [...notes].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch || String(a.id).localeCompare(String(b.id)));
const clamp = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;

export function normalizeMatchParameters(input = {}) {
  const d = DEFAULT_MATCH_PARAMETERS;
  return {
    threshold: clamp(input.threshold, d.threshold, 1, 100),
    onsetTolerance: clamp(input.onsetTolerance, d.onsetTolerance, 0, 2),
    durationTolerance: clamp(input.durationTolerance, d.durationTolerance, 0, 200),
    transpose: Math.round(clamp(input.transpose, d.transpose, 0, 24)),
    tempoTolerance: clamp(input.tempoTolerance, d.tempoTolerance, 0, 50),
    maxResults: Math.round(clamp(input.maxResults, d.maxResults, 1, 500)),
    skipAnnotated: input.skipAnnotated !== false,
  };
}

function lowerBound(notes, onset) {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (notes[middle].onset < onset) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Match note geometry, including chords. Each target note can match only once.
// Notes outside the template's pitch band are not part of the selected voice.
export function findSimilarAnnotationSegments({ template, sourceTracks, annotationTracks = [], level = 1, parameters, tpb = 24 }) {
  const p = normalizeMatchParameters(parameters);
  const reference = ordered(template?.notes ?? []);
  if (!reference.length) return { candidates: [], total: 0 };
  const start = reference[0].onset;
  const span = Math.max(...reference.map((note) => note.onset + note.duration)) - start;
  const lowPitch = Math.min(...reference.map((note) => note.pitch));
  const highPitch = Math.max(...reference.map((note) => note.pitch));
  const templateIds = new Set(reference.map((note) => note.id));
  const onsetTolerance = p.onsetTolerance * tpb;
  const tempoRange = p.tempoTolerance / 100;
  const second = reference.find((note) => note.onset > start);
  const found = new Map();
  for (const track of sourceTracks) {
    const notes = ordered(track.events);
    const byPitch = new Map();
    for (const note of notes) {
      if (!byPitch.has(note.pitch)) byPitch.set(note.pitch, []);
      byPitch.get(note.pitch).push(note);
    }
    const existing = annotationTracks.find((item) => item.trackId === track.id)?.layers[level]?.segments.filter((segment) => !segment.automatic) ?? [];
    const occupied = new Set(p.skipAnnotated ? existing.flatMap((segment) => segment.noteIds) : []);
    for (const anchor of notes) {
      const shift = anchor.pitch - reference[0].pitch;
      if (Math.abs(shift) > p.transpose || occupied.has(anchor.id)) continue;
      if (track.id === template.trackId && templateIds.has(anchor.id)) continue;
      const scales = new Set([1]);
      if (tempoRange) {
        for (let step = -4; step <= 4; step++) scales.add(1 + tempoRange * step / 4);
        if (second) {
          const delta = second.onset - start;
          const nextNotes = byPitch.get(second.pitch + shift) ?? [];
          for (let index = lowerBound(nextNotes, anchor.onset + delta * (1 - tempoRange)); index < nextNotes.length; index++) {
            const scale = (nextNotes[index].onset - anchor.onset) / delta;
            if (scale > 1 + tempoRange + 1e-9) break;
            scales.add(scale);
          }
        }
      }
      for (const scale of scales) {
        const matched = new Set();
        let quality = 0;
        for (const ref of reference) {
          const expected = anchor.onset + (ref.onset - start) * scale;
          const duration = ref.duration * scale;
          const durationTolerance = duration * p.durationTolerance / 100;
          const pool = byPitch.get(ref.pitch + shift) ?? [];
          let best = null;
          let bestQuality = -1;
          for (let index = lowerBound(pool, expected - onsetTolerance - 1e-9); index < pool.length; index++) {
            const note = pool[index];
            if (note.onset > expected + onsetTolerance + 1e-9) break;
            if (matched.has(note.id) || occupied.has(note.id)) continue;
            const durationError = Math.abs(note.duration - duration);
            if (durationError > durationTolerance + 1e-9) continue;
            const noteQuality = 1 - .25 * (onsetTolerance ? Math.abs(note.onset - expected) / onsetTolerance : 0)
              - .25 * (durationTolerance ? durationError / durationTolerance : 0);
            if (noteQuality > bestQuality) { best = note; bestQuality = noteQuality; }
          }
          if (best) { matched.add(best.id); quality += bestQuality; }
        }
        if (!matched.size || track.id === template.trackId && [...matched].some((id) => templateIds.has(id))) continue;
        const windowEnd = anchor.onset + span * scale;
        let inWindow = 0;
        for (let index = lowerBound(notes, anchor.onset - onsetTolerance); index < notes.length; index++) {
          const note = notes[index];
          if (note.onset >= windowEnd) break;
          if (note.pitch >= lowPitch + shift && note.pitch <= highPitch + shift) inWindow++;
        }
        const score = 2 * quality / (reference.length + Math.max(matched.size, inWindow));
        if (score + 1e-9 < p.threshold / 100) continue;
        const candidateNotes = notes.filter((note) => matched.has(note.id));
        // Always suppress an already-labeled exact note set, even when overlaps are allowed.
        if (existing.some((segment) => segment.noteIds.length === matched.size && segment.noteIds.every((id) => matched.has(id)))) continue;
        const key = JSON.stringify([track.id, candidateNotes.map((note) => note.id)]);
        const candidate = {
          id: key, trackId: track.id, noteIds: candidateNotes.map((note) => note.id), notes: candidateNotes,
          score, shift, scale, start: candidateNotes[0].onset,
          end: Math.max(...candidateNotes.map((note) => note.onset + note.duration)),
        };
        if (!found.has(key) || found.get(key).score < score) found.set(key, candidate);
      }
    }
  }
  // Keep the best of overlapping alignments, while allowing independent voices.
  const used = new Map();
  const candidates = [...found.values()].sort((a, b) => b.score - a.score || a.start - b.start).filter((candidate) => {
    if (!used.has(candidate.trackId)) used.set(candidate.trackId, new Set());
    const ids = used.get(candidate.trackId);
    if (candidate.noteIds.some((id) => ids.has(id))) return false;
    candidate.noteIds.forEach((id) => ids.add(id));
    return true;
  });
  return { candidates: candidates.slice(0, p.maxResults), total: candidates.length };
}
