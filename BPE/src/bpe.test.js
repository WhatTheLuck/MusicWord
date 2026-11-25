import { describe, expect, it } from 'vitest';
import { sequenceSimilarity, initialState, bpeStep, buildBpeHistory, buildBpeLayerView, buildHierarchyModel, isBpeRootAt, makeEvents, normalizeTracks } from './bpe';

const weights = { pitch: 1, velocity: 1, duration: 1, prevDelta: 1, nextDelta: 1, prevPitchDelta: 1, nextPitchDelta: 1 };
const event = (pitch) => ({
  pitch, name: 'C4', onset: 0, duration: 6, velocity: 100,
  prevDelta: 24, nextDelta: 24, prevPitchDelta: 0, nextPitchDelta: 0,
  normalized: { pitch: pitch / 127, velocity: 1, duration: .25, prevDelta: 1, nextDelta: 1, prevPitchDelta: .5, nextPitchDelta: .5 },
});

describe('music BPE', () => {
  it('returns 1 for identical arbitrary-length sequences', () => {
    const notes = [event(60), event(64), event(67)];
    expect(sequenceSimilarity(notes, notes, weights, 'cosine')).toBeCloseTo(1);
  });
  it('merges repeated adjacent word pairs in one round', () => {
    const track = { id: 't', events: [event(60), event(62), event(60), event(62)] };
    const next = bpeStep(initialState([track]), weights, 'euclidean', .99);
    expect(next.round).toBe(1);
    expect(next.sequences[0].words).toHaveLength(2);
    expect(next.lastMerge.count).toBe(2);
    expect(next.dictionary.N60.count).toBe(0);
    expect(next.dictionary.N62.count).toBe(0);
  });
  it('computes signed pitch differences to adjacent events', () => {
    const notes = [
      { ticks: 0, midi: 60, durationTicks: 12 },
      { ticks: 12, midi: 67, durationTicks: 12 },
      { ticks: 24, midi: 64, durationTicks: 12 },
    ];
    const events = makeEvents(notes, 24, 24, 8);
    expect(events.map(({ prevPitchDelta, nextPitchDelta }) => [prevPitchDelta, nextPitchDelta])).toEqual([
      [0, 7], [7, -3], [-3, 0],
    ]);
  });
  it('ignores external context at the left and right word boundaries', () => {
    const a = [event(60), event(64)];
    const b = a.map((note) => ({ ...note, normalized: { ...note.normalized } }));
    b[0].normalized.prevDelta = 0;
    b[0].normalized.prevPitchDelta = 0;
    b[1].normalized.nextDelta = 0;
    b[1].normalized.nextPitchDelta = 0;
    expect(sequenceSimilarity(a, b, weights, 'euclidean')).toBe(1);
    b[0].normalized.nextPitchDelta = 0;
    expect(sequenceSimilarity(a, b, weights, 'euclidean')).toBeLessThan(1);
  });
  it('excludes unavailable track-edge context from normalization extents', () => {
    const events = [
      { ...event(60), prevDelta: 999, prevPitchDelta: 999, nextDelta: 2, nextPitchDelta: 2 },
      { ...event(62), prevDelta: 2, prevPitchDelta: 2, nextDelta: 4, nextPitchDelta: 4 },
      { ...event(66), prevDelta: 4, prevPitchDelta: 4, nextDelta: 999, nextPitchDelta: 999 },
    ];
    const [track] = normalizeTracks([{ id: 't', events }]);
    expect(track.events[1].normalized.prevDelta).toBe(0);
    expect(track.events[1].normalized.nextDelta).toBe(1);
  });
  it('rebuilds the initial layer and advances to the requested round', () => {
    const track = { id: 't', events: Array.from({ length: 8 }, (_, index) => event(index % 2 ? 62 : 60)) };
    const history = buildBpeHistory([track], 2, weights, 'euclidean', .99);
    expect(history.map((state) => state.round)).toEqual([0, 1, 2]);
    expect(history[0].dictionary.M1).toBeUndefined();
    expect(history[2].dictionary.M2.count).toBe(2);
  });
  it('reclassifies base-layer events when similarity weights change', () => {
    const a = event(60);
    const b = { ...event(72), normalized: { ...event(72).normalized, pitch: 1, duration: .5 } };
    a.normalized = { ...a.normalized, pitch: 0, duration: .5 };
    const track = { id: 't', events: [a, b] };
    const pitchOnly = { ...weights, velocity: 0, duration: 0, prevDelta: 0, nextDelta: 0, prevPitchDelta: 0, nextPitchDelta: 0 };
    const durationOnly = { ...weights, pitch: 0, velocity: 0, duration: 1, prevDelta: 0, nextDelta: 0, prevPitchDelta: 0, nextPitchDelta: 0 };

    expect(initialState([track], pitchOnly, 'euclidean', .99).sequences[0].words.map((word) => word.id)).toEqual(['N1', 'N2']);
    expect(initialState([track], durationOnly, 'euclidean', .99).sequences[0].words.map((word) => word.id)).toEqual(['N1', 'N1']);
  });
  it('builds a live hierarchy from each merge to its previous-layer children', () => {
    const track = { id: 't', events: Array.from({ length: 8 }, (_, index) => ({ ...event(index % 2 ? 62 : 60), onset: index * 6 })) };
    const history = buildBpeHistory([track], 2, weights, 'euclidean', .99);
    const tree = buildHierarchyModel(history, 't');

    expect(tree.maxLevel).toBe(3);
    expect(tree.maxRank).toBe(2);
    expect(tree.nodes.filter((node) => node.level === 0)).toHaveLength(8);
    expect(tree.nodes.some((node) => node.round === 2 && node.level === 3)).toBe(true);
    expect(tree.edges.every((edge) => tree.nodes.some((node) => node.key === edge.parentKey) && tree.nodes.some((node) => node.key === edge.childKey))).toBe(true);
    expect(tree.edges.filter((edge) => edge.parentKey.startsWith('3:'))).toHaveLength(4);
    const view = buildBpeLayerView(new Map([['t', tree]]), [1, 3]);
    expect(view.tracks.get('t').nodes.every(({ level }) => [1, 3].includes(level))).toBe(true);
    expect(view.entries.map(({ level, count }) => [level, count])).toEqual([[3, 2], [1, 4]]);
    expect(view.tracks.get('t').edges).toHaveLength(4);
  });
  it('shows parentless words from every layer and compares roots as of each round', () => {
    const tracks = [
      { id: 'long', events: [60, 62, 60, 62, 60, 62, 60, 62, 80].map(event) },
      { id: 'short', events: [60, 62].map(event) },
    ];
    const history = buildBpeHistory(tracks, 2, weights, 'euclidean', .99);
    const hierarchies = new Map(tracks.map(({ id }) => [id, buildHierarchyModel(history, id)]));
    const levelsAt = (track, round) => hierarchies.get(track).nodes.filter((node) => isBpeRootAt(node, round))
      .map(({ level }) => level).sort();
    expect(levelsAt('long', 0)).toEqual(Array(9).fill(0));
    expect(levelsAt('long', 1)).toEqual([0, 1, 1, 1, 1]);
    expect(levelsAt('long', 2)).toEqual([0, 3, 3]);
    expect(levelsAt('short', 2)).toEqual([1]);
    const view = buildBpeLayerView(hierarchies, [3], true);
    expect(view.entries.map(({ level, count }) => [level, count]).sort()).toEqual([[0, 1], [1, 1], [3, 2]]);
    expect(view.tracks.get('long').edges).toEqual([]);
    expect(view.tracks.get('short').edges).toEqual([]);
  });
});
