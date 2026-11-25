export const FEATURE_KEYS = [
  'pitch', 'velocity', 'duration',
  'prevDelta', 'nextDelta',
  'prevPitchDelta', 'nextPitchDelta',
];

const PREVIOUS_CONTEXT_KEYS = new Set(['prevDelta', 'prevPitchDelta']);
const NEXT_CONTEXT_KEYS = new Set(['nextDelta', 'nextPitchDelta']);

export function makeEvents(notes, sourcePpq, tpb, saturationBeats) {
  const scale = tpb / sourcePpq;
  const cap = saturationBeats * tpb;
  const sorted = [...notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  return sorted.map((note, index) => {
    const onset = Math.round(note.ticks * scale);
    const prevOnset = index ? Math.round(sorted[index - 1].ticks * scale) : onset - cap;
    const nextOnset = index < sorted.length - 1 ? Math.round(sorted[index + 1].ticks * scale) : onset + cap;
    return {
      ...note,
      onset,
      pitch: note.midi,
      duration: Math.max(1, Math.round(note.durationTicks * scale)),
      prevDelta: Math.min(cap, Math.max(0, onset - prevOnset)),
      nextDelta: Math.min(cap, Math.max(0, nextOnset - onset)),
      prevPitchDelta: index ? note.midi - sorted[index - 1].midi : 0,
      nextPitchDelta: index < sorted.length - 1 ? sorted[index + 1].midi - note.midi : 0,
    };
  });
}

export function normalizeTracks(tracks) {
  const extents = Object.fromEntries(FEATURE_KEYS.map((key) => {
    const values = tracks.flatMap((track) => track.events
      .filter((_, index) => !PREVIOUS_CONTEXT_KEYS.has(key) || index > 0)
      .filter((_, index, events) => !NEXT_CONTEXT_KEYS.has(key) || index < events.length - 1)
      .map((event) => event[key]));
    if (!values.length) return [key, [0, 0]];
    return [key, [Math.min(...values), Math.max(...values)]];
  }));
  return tracks.map((track) => ({ ...track, events: track.events.map((event) => ({
    ...event,
    normalized: Object.fromEntries(FEATURE_KEYS.map((key) => {
      const [min, max] = extents[key];
      return [key, max === min ? 0 : (event[key] - min) / (max - min)];
    })),
  })) }));
}

function vector(event, weights, keys) {
  return keys.map((key) => event.normalized[key] * weights[key]);
}

function eventSimilarity(a, b, weights, metric, keys) {
  const av = vector(a, weights, keys), bv = vector(b, weights, keys);
  if (metric === 'euclidean') {
    const distance = Math.sqrt(av.reduce((sum, value, i) => sum + (value - bv[i]) ** 2, 0));
    const maxDistance = Math.sqrt(keys.reduce((sum, key) => sum + weights[key] ** 2, 0)) || 1;
    return Math.max(0, 1 - distance / maxDistance);
  }
  if (metric === 'manhattan') {
    const distance = av.reduce((sum, value, i) => sum + Math.abs(value - bv[i]), 0);
    const maxDistance = keys.reduce((sum, key) => sum + weights[key], 0) || 1;
    return Math.max(0, 1 - distance / maxDistance);
  }
  const dot = av.reduce((sum, value, i) => sum + value * bv[i], 0);
  const magA = Math.sqrt(av.reduce((sum, value) => sum + value ** 2, 0));
  const magB = Math.sqrt(bv.reduce((sum, value) => sum + value ** 2, 0));
  if (!magA && !magB) return 1;
  return magA && magB ? Math.max(0, Math.min(1, dot / (magA * magB))) : 0;
}

export function sequenceSimilarity(a, b, weights, metric = 'cosine') {
  if (!a.length || !b.length) return 0;
  const rows = a.length + 1, cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(Infinity));
  dp[0][0] = 0;
  for (let i = 1; i < rows; i++) for (let j = 1; j < cols; j++) {
    // A word does not own the context outside its left/right boundary. If either
    // aligned event touches a boundary, omit that side's contextual features.
    const keys = FEATURE_KEYS.filter((key) => {
      if ((i === 1 || j === 1) && PREVIOUS_CONTEXT_KEYS.has(key)) return false;
      if ((i === a.length || j === b.length) && NEXT_CONTEXT_KEYS.has(key)) return false;
      return true;
    });
    const cost = 1 - eventSimilarity(a[i - 1], b[j - 1], weights, metric, keys);
    dp[i][j] = cost + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  }
  const alignment = 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
  const lengthPenalty = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return Math.max(0, Math.min(1, alignment * (0.65 + 0.35 * lengthPenalty)));
}

export function initialState(tracks, weights = null, metric = 'cosine', threshold = 1) {
  const dictionary = {};
  const baseCategories = [];
  const sequences = tracks.map((track) => ({
    trackId: track.id,
    words: track.events.map((event, index) => {
      let id;
      if (weights) {
        let bestCategory = null;
        let bestScore = -1;
        for (const category of baseCategories) {
          const score = eventSimilarity(event, category.representative, weights, metric, FEATURE_KEYS);
          if (score >= threshold && score > bestScore) {
            bestCategory = category;
            bestScore = score;
          }
        }
        if (!bestCategory) {
          bestCategory = { id: `N${baseCategories.length + 1}`, representative: event };
          baseCategories.push(bestCategory);
        }
        id = bestCategory.id;
      } else {
        // Preserve the pitch-token fallback for direct callers that do not provide
        // clustering parameters. The app always supplies the active parameters.
        id = `N${event.pitch}`;
      }
      dictionary[id] ??= { id, level: 0, notes: [event], count: 0, label: event.name || `MIDI ${event.pitch}` };
      dictionary[id].count++;
      return { id, notes: [event], sourceIndex: index };
    }),
  }));
  return { round: 0, dictionary, sequences, lastMerge: null };
}

export function bpeStep(state, weights, metric, threshold) {
  const candidates = [];
  for (const sequence of state.sequences) {
    for (let i = 0; i < sequence.words.length - 1; i++) {
      const left = sequence.words[i], right = sequence.words[i + 1];
      candidates.push({ trackId: sequence.trackId, index: i, leftId: left.id, rightId: right.id, notes: [...left.notes, ...right.notes] });
    }
  }
  if (!candidates.length) return state;
  const clusters = [];
  for (const candidate of candidates) {
    let best = null, bestScore = -1;
    for (const cluster of clusters) {
      const score = sequenceSimilarity(candidate.notes, cluster.representative.notes, weights, metric);
      if (score >= threshold && score > bestScore) { best = cluster; bestScore = score; }
    }
    if (best) best.items.push(candidate);
    else clusters.push({ representative: candidate, items: [candidate] });
  }
  clusters.sort((a, b) => b.items.length - a.items.length || b.representative.notes.length - a.representative.notes.length);
  const winner = clusters[0];
  const newId = `M${state.round + 1}`;
  const newEntry = {
    id: newId,
    level: winner.representative.notes.length - 1,
    notes: winner.representative.notes,
    count: 0,
    label: `${winner.representative.leftId} + ${winner.representative.rightId}`,
  };
  const sequences = state.sequences.map((sequence) => {
    const words = [];
    for (let i = 0; i < sequence.words.length;) {
      if (i < sequence.words.length - 1) {
        const notes = [...sequence.words[i].notes, ...sequence.words[i + 1].notes];
        const score = sequenceSimilarity(notes, winner.representative.notes, weights, metric);
        if (score >= threshold) {
          words.push({ id: newId, notes, sourceIndex: sequence.words[i].sourceIndex, score });
          newEntry.count++;
          i += 2;
          continue;
        }
      }
      words.push(sequence.words[i]);
      i++;
    }
    return { ...sequence, words };
  });
  if (!newEntry.count) return state;
  const dictionary = Object.fromEntries(
    Object.entries({ ...state.dictionary, [newId]: newEntry }).map(([id, word]) => [id, { ...word, count: 0 }]),
  );
  for (const sequence of sequences) {
    for (const word of sequence.words) dictionary[word.id].count++;
  }
  return { round: state.round + 1, dictionary, sequences, lastMerge: { ...newEntry, count: dictionary[newId].count } };
}

export function buildBpeHistory(tracks, rounds, weights, metric, threshold) {
  if (!tracks.length) return [];
  const history = [initialState(tracks, weights, metric, threshold)];
  for (let index = 0; index < rounds; index++) {
    const current = history.at(-1);
    const next = bpeStep(current, weights, metric, threshold);
    if (next === current || next.round === current.round) break;
    history.push(next);
  }
  return history;
}

export function buildHierarchyModel(history, trackId) {
  if (!history.length) return { nodes: [], edges: [], maxLevel: 0, maxRank: 0 };
  const nodes = new Map();
  const edges = [];
  // A binary merge tree with n input notes has n - 1 aggregation operations.
  const keyFor = (word) => `${word.notes.length - 1}:${word.sourceIndex}:${word.id}`;
  const addNode = (word, round, rank) => {
    const key = keyFor(word);
    nodes.set(key, { key, word, level: word.notes.length - 1, round, rank, parentRound: null });
    return key;
  };

  const baseSequence = history[0].sequences.find((sequence) => sequence.trackId === trackId);
  baseSequence?.words.forEach((word) => addNode(word, 0, 0));

  for (let index = 1; index < history.length; index++) {
    const state = history[index];
    const previous = history[index - 1];
    const sequence = state.sequences.find((item) => item.trackId === trackId);
    const previousSequence = previous.sequences.find((item) => item.trackId === trackId);
    if (!sequence || !previousSequence) continue;

    sequence.words.filter((word) => word.id === `M${state.round}`).forEach((parent) => {
      const start = parent.sourceIndex;
      const end = start + parent.notes.length;
      const children = previousSequence.words.filter((child) => child.sourceIndex >= start && child.sourceIndex < end)
        .map((child) => nodes.get(keyFor(child)));
      const rank = Math.max(0, ...children.map((child) => child.rank)) + 1;
      const parentKey = addNode(parent, state.round, rank);
      children.forEach((child) => {
        child.parentRound = state.round;
        edges.push({ parentKey, childKey: child.key });
      });
    });
  }

  const orderedNodes = [...nodes.values()];
  return {
    nodes: orderedNodes,
    edges,
    maxLevel: orderedNodes.reduce((maximum, node) => Math.max(maximum, node.level), 0),
    maxRank: orderedNodes.reduce((maximum, node) => Math.max(maximum, node.rank), 0),
  };
}

export function isBpeRootAt({ round, parentRound }, atRound = Infinity) {
  return round <= atRound && (parentRound === null || atRound < parentRound);
}

export function buildBpeLayerView(hierarchies, visibleLevels, topWordsOnly = false) {
  const levels = new Set(visibleLevels);
  const tracks = new Map();
  const entries = new Map();
  for (const [trackId, model] of hierarchies) {
    const nodes = model.nodes.filter((node) => topWordsOnly ? isBpeRootAt(node) : levels.has(node.level))
      .sort((a, b) => b.level - a.level || a.word.sourceIndex - b.word.sourceIndex)
      .map((node) => ({ ...node, trackId, instanceKey: `${trackId}:${node.key}` }));
    const keys = new Set(nodes.map(({ key }) => key));
    const edges = model.edges.filter(({ parentKey, childKey }) => keys.has(parentKey) && keys.has(childKey));
    tracks.set(trackId, { ...model, nodes, edges });
    for (const node of nodes) {
      const { word, level } = node;
      const key = `${word.id}:${level}`;
      if (!entries.has(key)) entries.set(key, { ...word, key, level, instances: [] });
      entries.get(key).instances.push(node);
    }
  }
  return { tracks, entries: [...entries.values()].map((entry) => ({ ...entry, count: entry.instances.length })) };
}

export function wordColor(word) {
  if (typeof word === 'object' && word?.color) return word.color;
  const id = typeof word === 'object' ? word.id : String(word);
  const numeric = Number(id.replace(/\D/g, '')) || 0;
  const familyOffset = id.startsWith('M') ? 43 : id.startsWith('N') ? 0 : 86;
  const hue = Math.round((numeric * 137.508 + familyOffset) % 360);
  return `hsl(${hue} 62% 62%)`;
}
