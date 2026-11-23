import { describe, expect, it } from 'vitest';
import { findSimilarAnnotationSegments } from './annotation-match';
import {
  acceptAnnotationMatches, applyAnnotation, buildAnnotationExport, buildAnnotationHierarchy,
  createTrackAnnotation, deleteAnnotationSegments, editAnnotation, insertAnnotationLayer, restoreAnnotationTracks,
} from './annotation';

const phrase = (prefix, start = 0, shift = 0, scale = 1) => [
  { id: `${prefix}0`, onset: start, duration: 9 * scale, pitch: 60 + shift },
  { id: `${prefix}1`, onset: start + 12 * scale, duration: 9 * scale, pitch: 64 + shift },
  { id: `${prefix}2`, onset: start + 24 * scale, duration: 12 * scale, pitch: 67 + shift },
];
const original = phrase('a');
const template = { trackId: 't', segmentId: 'template', notes: original };
const find = (events, parameters = {}, extra = {}) => findSimilarAnnotationSegments({
  template, sourceTracks: [{ id: 't', events: [...original, ...events] }],
  parameters: { threshold: 100, onsetTolerance: 0, durationTolerance: 0, tempoTolerance: 0, ...parameters }, ...extra,
});

describe('annotation similarity search', () => {
  it('finds exact repeats, excludes the template, and does not change input', () => {
    const events = phrase('b', 96);
    const before = JSON.stringify(events);
    const result = find(events);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ noteIds: ['b0', 'b1', 'b2'], score: 1, shift: 0, scale: 1 });
    expect(JSON.stringify(events)).toBe(before);
  });

  it('honors transposition limits and estimates non-grid tempo scales', () => {
    const events = phrase('b', 96, 5, 1.13);
    expect(find(events).total).toBe(0);
    const result = find(events, { transpose: 5, tempoTolerance: 20 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ shift: 5 });
    expect(result.candidates[0].scale).toBeCloseTo(1.13);
    expect(find(events, { transpose: 4, tempoTolerance: 20 }).total).toBe(0);
    expect(find(events, { transpose: 5, tempoTolerance: 10 }).total).toBe(0);
  });

  it('supports polyphonic templates and ignores notes in another pitch band', () => {
    const chord = [original[0], { ...original[0], id: 'chord', pitch: 65 }, original[1]];
    const repeat = chord.map((note) => ({ ...note, id: `r:${note.id}`, onset: note.onset + 96 }));
    const result = find([...repeat, { id: 'bass', onset: 96, duration: 10, pitch: 40 }], {}, {
      template: { ...template, notes: chord }, sourceTracks: [{ id: 't', events: [...chord, ...repeat, { id: 'bass', onset: 96, duration: 10, pitch: 40 }] }],
    });
    expect(result.candidates[0].noteIds).toEqual(['r:a0', 'r:chord', 'r:a1']);
  });

  it('penalizes missing and extra notes rather than producing perfect partial matches', () => {
    expect(find(phrase('b', 96).slice(0, 2)).total).toBe(0);
    expect(find(phrase('b', 96).slice(0, 2), { threshold: 75 }).candidates[0].score).toBeCloseTo(.8);
    const extra = [...phrase('b', 96), { id: 'extra', onset: 102, duration: 3, pitch: 62 }];
    expect(find(extra).total).toBe(0);
    expect(find(extra, { threshold: 80 }).candidates[0].score).toBeCloseTo(6 / 7);
  });

  it('uses onset and duration tolerances and suppresses duplicate alignments', () => {
    const repeat = phrase('b', 96);
    repeat[1].onset += 1;
    repeat[1].duration += 2;
    expect(find(repeat).total).toBe(0);
    const result = find(repeat, { threshold: 85, onsetTolerance: .125, durationTolerance: 35, tempoTolerance: 20 });
    expect(result.total).toBe(1);
    expect(result.candidates[0].score).toBeLessThan(1);
  });

  it('skips occupied notes by default and never duplicates an existing exact note set', () => {
    const events = [...original, ...phrase('b', 96)];
    const track = { id: 't', events };
    const partlyLabeled = applyAnnotation(createTrackAnnotation(track), 1, ['b0'], ['note:b0'], 'B').track;
    expect(find(phrase('b', 96), {}, { annotationTracks: [partlyLabeled] }).total).toBe(0);
    expect(find(phrase('b', 96), { skipAnnotated: false }, { annotationTracks: [partlyLabeled] }).total).toBe(1);
    const labeled = applyAnnotation(createTrackAnnotation(track), 1, ['b0', 'b1', 'b2'], [], 'A').track;
    expect(find(phrase('b', 96), { skipAnnotated: false }, { annotationTracks: [labeled] }).total).toBe(0);
  });

  it('distinguishes tracks with identical note IDs and caps previews after ranking', () => {
    const result = find([], { maxResults: 1 }, { sourceTracks: [
      { id: 't', events: original }, { id: 'other', events: original }, { id: 'third', events: original },
    ] });
    expect(result.total).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(findSimilarAnnotationSegments({ template: { notes: [] }, sourceTracks: [] }).total).toBe(0);
  });
});

describe('assisted annotations remain editable', () => {
  const source = { id: 't', signature: 's', events: [...original, ...phrase('b', 96), ...phrase('c', 192)] };
  const initial = applyAnnotation(createTrackAnnotation(source), 1, ['a0', 'a1', 'a2'], [], 'A').track;
  const candidates = findSimilarAnnotationSegments({ template, sourceTracks: [source], annotationTracks: [initial], parameters: { threshold: 100, tempoTolerance: 0 } }).candidates;

  it('accepts only selected results as deletable words and suppresses repeated acceptance', () => {
    const accepted = acceptAnnotationMatches([initial], 1, candidates.slice(0, 1), 'A', template, {});
    expect(accepted.added).toHaveLength(1);
    const segment = accepted.tracks[0].layers[1].segments[1];
    expect(segment.automatic).toBe(false);
    expect(segment.assistance).toMatchObject({ templateId: 'template', score: 1, batchId: accepted.batchId });
    expect(initial.layers[1].segments).toHaveLength(1);
    expect(acceptAnnotationMatches(accepted.tracks, 1, candidates.slice(0, 1), 'A', template, {}).added).toHaveLength(0);
    expect(deleteAnnotationSegments(accepted.tracks, 1, accepted.added)[0].layers[1].segments).toEqual(initial.layers[1].segments);
  });

  it('changes categories and ranges while preserving identity and provenance across export/restore', () => {
    const accepted = acceptAnnotationMatches([initial], 1, candidates, 'A', template, {});
    const segment = accepted.tracks[0].layers[1].segments[1];
    const edited = editAnnotation(accepted.tracks[0], 1, segment.id, { categoryId: 'B', noteIds: ['b2', 'b0'], sourceSegmentIds: ['note:b0', 'note:b2'] });
    expect(edited.layers[1].segments[1]).toMatchObject({ id: segment.id, categoryId: 'B', noteIds: ['b0', 'b2'], assistance: { edited: true } });
    const document = buildAnnotationExport({ tracks: [edited], categories: [], tpb: 24, midi: { tracks: [{ id: source.id, signature: 's' }] } });
    const restored = restoreAnnotationTracks(JSON.parse(JSON.stringify(document)), [source])[0];
    expect(restored.layers[1].segments[1].assistance).toEqual(edited.layers[1].segments[1].assistance);
    expect(deleteAnnotationSegments([restored], 1, accepted.added)[0].layers[1].segments).toEqual(initial.layers[1].segments);
  });

  it('supports higher-layer words without altering lower-layer annotations', () => {
    let track = initial;
    track = applyAnnotation(track, 1, ['b0', 'b1', 'b2'], ['note:b0', 'note:b1', 'note:b2'], 'B').track;
    track = insertAnnotationLayer(track, 2, 'higher');
    const lower = track.layers[1];
    const accepted = acceptAnnotationMatches([track], 2, candidates.slice(0, 1), 'C', { ...template, level: 2 }, {});
    expect(accepted.tracks[0].layers[1]).toBe(lower);
    const upper = accepted.tracks[0].layers[2].segments[0];
    expect(upper.sourceSegmentIds).toEqual([lower.segments[1].id]);
    expect(buildAnnotationHierarchy(accepted.tracks[0], source, []).edges).toContainEqual({ parentKey: `2:${upper.id}`, childKey: `1:${lower.segments[1].id}` });
  });
});
