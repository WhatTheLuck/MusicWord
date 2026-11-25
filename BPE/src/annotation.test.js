import { describe, expect, it } from 'vitest';
import {
  aggregateAnnotationNodes, applyAnnotation, buildAnnotationExport, buildAnnotationHierarchy, buildAnnotationSelectionWord, buildAnnotationView,
  createTrackAnnotation, editAnnotation, layerCoverage,
  insertAnnotationLayer, nextEmptyAnnotationCategory, reconcileAnnotationTracks, restoreAnnotationTracks,
} from './annotation';

const track = {
  id: 'track',
  events: Array.from({ length: 4 }, (_, index) => ({ id: `n${index}`, onset: index * 12, pitch: 60 + index })),
};

describe('manual annotation model', () => {
  it('starts with note and song boundaries plus an empty word layer', () => {
    const state = createTrackAnnotation(track);
    expect(state.layers.map((layer) => layer.role)).toEqual(['bottom', 'manual', 'top']);
    expect(layerCoverage(state, 0).complete).toBe(true);
    expect(layerCoverage(state, 1).percent).toBe(0);
    expect(layerCoverage(state, 2).complete).toBe(true);
  });

  it('counts distinct covered notes when annotations share the same note', () => {
    let state = createTrackAnnotation(track);
    state = applyAnnotation(state, 1, ['n0', 'n1'], ['note:n0', 'note:n1'], 'A').track;
    const result = aggregateAnnotationNodes([state], track.id, 0, ['note:n1', 'note:n2'], 'B');
    expect(result.error).toBe('');
    expect(result.tracks[0].layers[1].segments.map((segment) => segment.noteIds)).toEqual([['n0', 'n1'], ['n1', 'n2']]);
    expect(layerCoverage(result.tracks[0], 1)).toMatchObject({ covered: 3, total: 4, complete: false });
  });

  it('overwrites an exact range in the same layer and repairs links to legacy duplicates', () => {
    const first = applyAnnotation(createTrackAnnotation(track), 1, ['n0', 'n1'], ['note:n0', 'note:n1'], 'A');
    const overlap = applyAnnotation(first.track, 1, ['n1', 'n2'], ['note:n1', 'note:n2'], 'B');
    const legacy = { ...first.segment, id: 'old-duplicate', categoryId: 'B' };
    const expanded = insertAnnotationLayer(overlap.track, 2, 'parents');
    expanded.layers[1] = { ...expanded.layers[1], segments: [...expanded.layers[1].segments, legacy] };
    const higher = applyAnnotation(expanded, 2, ['n0', 'n1', 'n2'], [first.segment.id, legacy.id, overlap.segment.id], 'D');

    const result = aggregateAnnotationNodes([higher.track], track.id, 0, ['note:n1', 'note:n0'], 'C');
    expect(result).toMatchObject({ replaced: true, segment: { id: first.segment.id, categoryId: 'C' } });
    const directlyEdited = editAnnotation(higher.track, 1, legacy.id, { categoryId: 'C' });
    for (const [updated, retainedId] of [[result.tracks[0], first.segment.id], [directlyEdited, legacy.id]]) {
      expect(updated.layers[0]).toBe(higher.track.layers[0]);
      expect(updated.layers[1].segments).toEqual([
        expect.objectContaining({ id: retainedId, categoryId: 'C', noteIds: ['n0', 'n1'] }), overlap.segment,
      ]);
      expect(updated.layers[2].segments[0]).toMatchObject({ categoryId: 'D', sourceSegmentIds: [retainedId, overlap.segment.id] });
    }
  });

  it('creates a word from a single selected note node', () => {
    const result = aggregateAnnotationNodes([createTrackAnnotation(track)], track.id, 0, ['note:n2'], 'A');
    expect(result).toMatchObject({ parentLevel: 1, insertedLayer: false, error: '' });
    expect(result.segment).toMatchObject({ noteIds: ['n2'], sourceSegmentIds: ['note:n2'] });
  });

  it('preserves compatible annotations while selected tracks are reconciled', () => {
    const initial = createTrackAnnotation(track);
    expect(reconcileAnnotationTracks([initial], [track])[0]).toBe(initial);
  });

  it('inserts arbitrary intermediate layers without moving the note or song boundaries', () => {
    const initial = createTrackAnnotation(track);
    const expanded = insertAnnotationLayer(initial, 2, 'words-extra');
    expect(expanded.layers).toHaveLength(4);
    expect(expanded.layers[0].role).toBe('bottom');
    expect(expanded.layers.at(-1).role).toBe('top');
    expect(expanded.layers[2]).toMatchObject({ id: 'words-extra', role: 'manual', segments: [] });
  });

  it('labels an intermediate layer using the available words of an incomplete lower layer', () => {
    const initial = createTrackAnnotation(track);
    const lower = applyAnnotation(initial, 1, ['n0', 'n1'], ['note:n0', 'note:n1'], 'A');
    const expanded = insertAnnotationLayer(lower.track, 2, 'words-extra');
    const higher = applyAnnotation(expanded, 2, lower.segment.noteIds, [lower.segment.id], 'B');
    expect(higher.error).toBe('');
    expect(higher.segment.sourceSegmentIds).toEqual([lower.segment.id]);
    expect(layerCoverage(higher.track, 1).complete).toBe(false);
    expect(layerCoverage(higher.track, 2).complete).toBe(false);
  });

  it('exports a whole-song label created before lower words and links words added later', () => {
    const initial = createTrackAnnotation(track);
    const wholeSong = applyAnnotation(initial, 2, initial.noteIds, [], 'B');
    expect(wholeSong.error).toBe('');
    const lower = applyAnnotation(wholeSong.track, 1, ['n0', 'n1'], ['note:n0', 'note:n1'], 'A');
    const exported = buildAnnotationExport({ tracks: [lower.track], categories: [], tpb: 12 });
    expect(exported.tracks[0].layers[1].complete).toBe(false);
    expect(exported.tracks[0].layers[2].words[0]).toMatchObject({
      categoryId: 'B',
      noteIds: initial.noteIds,
      sourceWordIds: [lower.segment.id],
    });
  });

  it('aggregates adjacent words into a new parent layer shared by the selected tracks', () => {
    const first = applyAnnotation(createTrackAnnotation(track), 1, ['n0'], ['note:n0'], 'A');
    const second = applyAnnotation(first.track, 1, ['n1'], ['note:n1'], 'B');
    const other = createTrackAnnotation({ ...track, id: 'other' });
    const result = aggregateAnnotationNodes([second.track, other], track.id, 1, [second.segment.id, first.segment.id], 'C', 'parents');
    expect(result).toMatchObject({ parentLevel: 2, insertedLayer: true, error: '' });
    expect(result.segment).toMatchObject({
      noteIds: ['n0', 'n1'],
      sourceSegmentIds: [first.segment.id, second.segment.id],
    });
    expect(result.tracks[0].layers[1].segments).toEqual(second.track.layers[1].segments);
    expect(result.tracks[1].layers[2]).toMatchObject({ id: 'parents', segments: [] });
    const addedTrack = reconcileAnnotationTracks(result.tracks, [track, { ...track, id: 'added' }])[1];
    expect(addedTrack.layers[2]).toMatchObject({ id: 'parents', segments: [] });
    expect(addedTrack.layers.at(-1).segments[0].id).toBe('song:added');
  });

  it('preserves the chosen child links across export and restore when parent nodes share notes and children', () => {
    let state = insertAnnotationLayer(createTrackAnnotation(track), 2, 'parents');
    for (const ids of [['n0', 'n1'], ['n1', 'n2'], ['n1', 'n3']]) {
      state = applyAnnotation(state, 1, ids, ids.map((id) => `note:${id}`), 'A').track;
    }
    const [first, second, third] = state.layers[1].segments.map((segment) => segment.id);
    const result = aggregateAnnotationNodes([state], track.id, 1, [first, third], 'B', 'unused');
    expect(result).toMatchObject({ parentLevel: 2, insertedLayer: false, error: '' });
    expect(result.segment.noteIds).toEqual(['n0', 'n1', 'n3']);
    const other = aggregateAnnotationNodes(result.tracks, track.id, 1, [second, third], 'C', 'unused');
    expect(other.error).toBe('');
    const exported = buildAnnotationExport({ tracks: other.tracks, categories: [], tpb: 12 });
    expect(exported.tracks[0].layers[2].words.map((word) => word.sourceWordIds)).toEqual([[first, third], [second, third]]);
    const [restored] = restoreAnnotationTracks(exported, [track]);
    const hierarchy = buildAnnotationHierarchy(restored, track, []);
    const children = (id) => hierarchy.edges.filter(({ parentKey }) => parentKey === `2:${id}`).map(({ childKey }) => childKey);
    expect(children(result.segment.id)).toEqual([`1:${first}`, `1:${third}`]);
    expect(children(other.segment.id)).toEqual([`1:${second}`, `1:${third}`]);
  });

  it('projects manual labels into dictionary, sequence, frequency, table, and tree data', () => {
    let annotated = createTrackAnnotation(track);
    annotated = applyAnnotation(annotated, 1, ['n0', 'n1'], ['note:n0', 'note:n1'], 'A').track;
    annotated = applyAnnotation(annotated, 1, ['n2', 'n3'], ['note:n2', 'note:n3'], 'A').track;
    const categories = [{ id: 'A', label: '词类 A', color: '#f0a000' }];
    const view = buildAnnotationView([annotated], [track], 1, categories);
    const hierarchy = buildAnnotationHierarchy(annotated, track, categories);
    expect(view.sequences[0].words).toHaveLength(2);
    expect(view.entries[0]).toMatchObject({ id: 'A', count: 2, level: 1, color: '#f0a000' });
    expect(hierarchy.nodes).toHaveLength(7);
    expect(hierarchy.edges).toHaveLength(6);
  });

  it('chooses the next new empty dictionary slot and safely falls back when all slots are used', () => {
    const categories = ['A', 'B', 'C', 'D'].map((id) => ({ id }));
    expect(nextEmptyAnnotationCategory(categories, {})).toBe('A');
    expect(nextEmptyAnnotationCategory(categories, { A: 2, C: 1 })).toBe('D');
    expect(nextEmptyAnnotationCategory(categories, { A: 2, C: 1, D: 1 })).toBe('B');
    expect(nextEmptyAnnotationCategory(categories, { A: 1, B: 1, C: 1, D: 1 })).toBe('D');
  });

  it('builds an ordered playable word from the current marquee selection', () => {
    const word = buildAnnotationSelectionWord(track, ['n2', 'missing', 'n0']);
    expect(word).toMatchObject({ id: 'SELECTION', label: '框选片段' });
    expect(word.notes.map((note) => note.id)).toEqual(['n0', 'n2']);
    expect(buildAnnotationSelectionWord(track, ['missing'])).toBeNull();
  });
});
