export const ANNOTATION_CATEGORIES = [
  { id: 'A', label: '词类 A', color: '#e7aa46' },
  { id: 'B', label: '词类 B', color: '#62b6cb' },
  { id: 'C', label: '词类 C', color: '#d884b7' },
  { id: 'D', label: '词类 D', color: '#8fca79' },
  { id: 'E', label: '词类 E', color: '#a89be8' },
  { id: 'F', label: '词类 F', color: '#e18763' },
  { id: 'G', label: '词类 G', color: '#72c4a1' },
  { id: 'H', label: '词类 H', color: '#d2bd65' },
];

const noteOrder = (notes) => [...notes].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch || String(a.id).localeCompare(String(b.id)));

export function createTrackAnnotation(track) {
  const notes = noteOrder(track.events);
  const noteSegments = notes.map((note, index) => ({
    id: `note:${note.id}`,
    categoryId: 'NOTE',
    noteIds: [note.id],
    automatic: true,
    order: index,
  }));
  return {
    trackId: track.id,
    noteIds: notes.map((note) => note.id),
    layers: [
      { id: 'notes', name: '音符层', role: 'bottom', segments: noteSegments },
      { id: 'words', name: '音乐词层', role: 'manual', segments: [] },
      {
        id: 'song', name: '整首乐曲', role: 'top', segments: notes.length ? [{
          id: `song:${track.id}`,
          categoryId: 'SONG',
          noteIds: notes.map((note) => note.id),
          automatic: true,
          order: 0,
        }] : [],
      },
    ],
  };
}

export function reconcileAnnotationTracks(previous, tracks) {
  const oldById = new Map((previous ?? []).map((track) => [track.trackId, track]));
  const layout = tracks.map((track) => oldById.get(track.id)).find(Boolean)?.layers;
  return tracks.map((track) => {
    const old = oldById.get(track.id);
    const nextIds = noteOrder(track.events).map((note) => note.id);
    if (old && old.noteIds.length === nextIds.length && old.noteIds.every((id, index) => id === nextIds[index])) return old;
    const fresh = createTrackAnnotation(track);
    if (!layout) return fresh;
    return {
      ...fresh,
      layers: layout.map((layer) => ({
        ...layer,
        segments: fresh.layers.find((item) => item.id === layer.id)?.segments ?? [],
      })),
    };
  });
}

export function insertAnnotationLayer(trackAnnotation, index, layerId) {
  if (index <= 0 || index >= trackAnnotation.layers.length) return trackAnnotation;
  const layers = [...trackAnnotation.layers];
  layers.splice(index, 0, { id: layerId, name: '音乐词层', role: 'manual', segments: [] });
  return {
    ...trackAnnotation,
    layers: layers.map((layer, level) => layer.role === 'manual' ? { ...layer, name: `音乐词层 ${level}` } : layer),
  };
}

export function layerCoverage(trackAnnotation, level) {
  const layer = trackAnnotation?.layers[level];
  const total = trackAnnotation?.noteIds.length ?? 0;
  if (!layer || !total) return { covered: 0, total, complete: false, percent: 0 };
  const validIds = new Set(trackAnnotation.noteIds);
  const coveredIds = new Set(layer.segments.flatMap((segment) => segment.noteIds).filter((id) => validIds.has(id)));
  return {
    covered: coveredIds.size,
    total,
    complete: coveredIds.size === total,
    percent: Math.round((coveredIds.size / total) * 100),
  };
}

export function sourceSegmentsForLevel(trackAnnotation, level) {
  if (!trackAnnotation) return [];
  return trackAnnotation.layers[Math.max(0, level - 1)]?.segments ?? [];
}

const sameNotes = (segment, ids) => segment.noteIds.length === ids.size && segment.noteIds.every((id) => ids.has(id));

export function applyAnnotation(trackAnnotation, level, noteIds, sourceSegmentIds, categoryId) {
  const layer = trackAnnotation.layers[level];
  const selectedNotes = new Set(noteIds);
  const orderedNoteIds = trackAnnotation.noteIds.filter((id) => selectedNotes.has(id));
  if (!layer || !categoryId || !orderedNoteIds.length) return { track: trackAnnotation, error: '请选择音符和单词类别' };

  const exactNotes = new Set(orderedNoteIds);
  const existing = layer.segments.find((segment) => !segment.automatic && sameNotes(segment, exactNotes));
  if (existing) {
    const track = editAnnotation(trackAnnotation, level, existing.id, { categoryId, sourceSegmentIds: [...new Set(sourceSegmentIds)] });
    const segment = track.layers[level].segments.find((item) => item.id === existing.id);
    return { track, segment, replaced: true, error: '' };
  }

  const automaticTop = layer.role === 'top' ? layer.segments.filter((segment) => segment.automatic) : [];
  const remaining = layer.segments.filter((segment) => !automaticTop.includes(segment));
  const segment = {
    id: `${layer.id}:${categoryId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    categoryId,
    noteIds: orderedNoteIds,
    sourceSegmentIds: [...new Set(sourceSegmentIds)],
    automatic: false,
    order: trackAnnotation.noteIds.indexOf(orderedNoteIds[0]),
  };
  const layers = trackAnnotation.layers.map((item, index) => index === level
    ? { ...item, segments: [...remaining, segment].sort((a, b) => a.order - b.order) }
    : item);
  return { track: { ...trackAnnotation, layers }, segment, error: '' };
}

export function aggregateAnnotationNodes(tracks, trackId, level, sourceSegmentIds, categoryId, layerId) {
  const track = tracks.find((item) => item.trackId === trackId);
  const sourceLayer = track?.layers[level];
  const parentLevel = level + 1;
  const parentLayer = track?.layers[parentLevel];
  if (!sourceLayer || sourceLayer.role === 'top' || !parentLayer) return { error: '请选择音符或音乐词节点' };

  const selectedIds = new Set(sourceSegmentIds);
  const children = sourceLayer.segments.filter((segment) => selectedIds.has(segment.id));
  if (!children.length || children.length !== selectedIds.size) return { error: '请至少选择一个有效节点' };

  const insertedLayer = parentLayer.role === 'top';
  const target = insertedLayer ? insertAnnotationLayer(track, parentLevel, layerId) : track;
  const result = applyAnnotation(target, parentLevel, children.flatMap((child) => child.noteIds), children.map((child) => child.id), categoryId);
  if (result.error) return { error: result.error };

  return {
    tracks: tracks.map((item) => {
      if (item.trackId === trackId) return result.track;
      return insertedLayer ? insertAnnotationLayer(item, parentLevel, layerId) : item;
    }),
    parentLevel,
    insertedLayer,
    segment: result.segment,
    replaced: Boolean(result.replaced),
    error: '',
  };
}

export function removeAnnotation(trackAnnotation, level, segmentId) {
  const layer = trackAnnotation.layers[level];
  if (!layer) return trackAnnotation;
  const layers = trackAnnotation.layers.map((item, index) => index === level
    ? { ...item, segments: item.segments.filter((segment) => segment.id !== segmentId || segment.automatic) }
    : item);
  return { ...trackAnnotation, layers };
}

export function editAnnotation(track, level, segmentId, changes) {
  const segments = track.layers[level]?.segments;
  const segment = segments?.find((item) => item.id === segmentId && !item.automatic);
  if (!segment) return track;
  const selected = new Set(changes.noteIds ?? segment.noteIds);
  const noteIds = track.noteIds.filter((id) => selected.has(id));
  if (!noteIds.length) return track;
  const exactNotes = new Set(noteIds);
  const duplicates = new Set(segments.filter((item) => item.id !== segmentId && !item.automatic && sameNotes(item, exactNotes))
    .map((item) => item.id));
  const edited = { ...segment, ...changes, id: segmentId, automatic: false, noteIds,
    order: track.noteIds.indexOf(noteIds[0]),
    ...(segment.assistance ? { assistance: { ...segment.assistance, edited: true } } : {}),
  };
  const layers = track.layers.map((layer, index) => {
    if (index === level) return { ...layer, segments: segments.filter((item) => !duplicates.has(item.id))
      .map((item) => item.id === segmentId ? edited : item).sort((a, b) => a.order - b.order) };
    if (index !== level + 1 || !duplicates.size) return layer;
    return { ...layer, segments: layer.segments.map((parent) => {
      if (!parent.sourceSegmentIds?.some((id) => duplicates.has(id))) return parent;
      const sourceSegmentIds = [...new Set(parent.sourceSegmentIds.map((id) => duplicates.has(id) ? segmentId : id))];
      return { ...parent, sourceSegmentIds };
    }) };
  });
  return { ...track, layers };
}

export function deleteAnnotationSegments(tracks, level, targets) {
  return tracks.map((track) => {
    const ids = new Set(targets.filter((target) => target.trackId === track.trackId).map((target) => target.segmentId));
    if (!ids.size) return track;
    return { ...track, layers: track.layers.map((layer, index) => ({
      ...layer,
      segments: index === level ? layer.segments.filter((segment) => segment.automatic || !ids.has(segment.id))
        : index === level + 1 ? layer.segments.map((segment) => ({ ...segment,
          sourceSegmentIds: segment.sourceSegmentIds?.filter((id) => !ids.has(id)),
        })) : layer.segments,
    })) };
  });
}

export function acceptAnnotationMatches(tracks, level, candidates, categoryId, template, parameters) {
  const batchId = `match:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const added = [];
  const next = tracks.map((track) => {
    if (track.layers[level]?.role !== 'manual') return track;
    let result = track;
    for (const candidate of candidates.filter((item) => item.trackId === track.trackId)) {
      const valid = new Set(track.noteIds);
      const ids = new Set(candidate.noteIds);
      if (!ids.size || [...ids].some((id) => !valid.has(id))) continue;
      const existing = result.layers[level].segments;
      if (existing.some((segment) => sameNotes(segment, ids))) continue;
      if (parameters.skipAnnotated !== false && existing.some((segment) => !segment.automatic && segment.noteIds.some((id) => ids.has(id)))) continue;
      // Link whole lower-layer nodes only; do not claim a partially matched child.
      const children = result.layers[level - 1].segments.filter((segment) => segment.noteIds.every((id) => ids.has(id)));
      const applied = applyAnnotation(result, level, candidate.noteIds, children.map((child) => child.id), categoryId);
      if (applied.error) continue;
      applied.segment.assistance = {
        batchId, templateId: template.segmentId, templateTrackId: template.trackId,
        score: candidate.score, shift: candidate.shift, scale: candidate.scale, parameters: { ...parameters },
      };
      added.push({ trackId: track.trackId, segmentId: applied.segment.id });
      result = applied.track;
    }
    return result;
  });
  return { tracks: next, added, batchId };
}

export function annotationCategoryCounts(tracks, level) {
  const counts = {};
  tracks.forEach((track) => track.layers[level]?.segments.forEach((segment) => {
    if (!segment.automatic) counts[segment.categoryId] = (counts[segment.categoryId] ?? 0) + 1;
  }));
  return counts;
}

export function nextEmptyAnnotationCategory(categories, counts) {
  const lastUsedIndex = categories.reduce((last, category, index) => counts[category.id] ? index : last, -1);
  return categories.slice(lastUsedIndex + 1).find((category) => !counts[category.id])?.id
    ?? categories.find((category) => !counts[category.id])?.id
    ?? categories[Math.max(0, lastUsedIndex)]?.id
    ?? null;
}

export function buildAnnotationSelectionWord(track, noteIds) {
  const selected = new Set(noteIds);
  const notes = noteOrder((track?.events ?? []).filter((note) => selected.has(note.id)));
  if (!notes.length) return null;
  return {
    id: 'SELECTION',
    label: '框选片段',
    color: '#e7aa46',
    notes,
  };
}

const boundaryCategory = (id) => id === 'NOTE'
  ? { id: 'NOTE', label: '单个音符', color: '#77766d' }
  : { id: 'SONG', label: '整首乐曲', color: '#b8a16f' };

function annotationWord(segment, trackAnnotation, level, categoryById, noteById, noteIndexById) {
  const notes = segment.noteIds.map((id) => noteById.get(id)).filter(Boolean);
  const category = categoryById.get(segment.categoryId) ?? boundaryCategory(segment.categoryId);
  const sourceIndex = Math.min(...segment.noteIds.map((id) => noteIndexById.get(id)).filter((index) => index != null));
  return {
    id: segment.categoryId,
    instanceId: segment.id,
    level,
    notes,
    sourceIndex: Number.isFinite(sourceIndex) ? sourceIndex : 0,
    label: category.label,
    color: category.color,
    automatic: Boolean(segment.automatic),
    assistance: segment.assistance,
  };
}

export function buildAnnotationView(tracks, sourceTracks, level, categories) {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const sourceById = new Map(sourceTracks.map((track) => [track.id, track]));
  const sequences = tracks.map((trackAnnotation) => {
    const track = sourceById.get(trackAnnotation.trackId);
    if (!track) return { trackId: trackAnnotation.trackId, words: [] };
    const noteById = new Map(track.events.map((note) => [note.id, note]));
    const noteIndexById = new Map(trackAnnotation.noteIds.map((id, index) => [id, index]));
    const words = (trackAnnotation.layers[level]?.segments ?? [])
      .map((segment) => annotationWord(segment, trackAnnotation, level, categoryById, noteById, noteIndexById))
      .sort((a, b) => a.sourceIndex - b.sourceIndex);
    return { trackId: trackAnnotation.trackId, words };
  });
  const entriesById = new Map();
  sequences.forEach((sequence) => sequence.words.forEach((word) => {
    const entry = entriesById.get(word.id);
    if (entry) entry.count += 1;
    else entriesById.set(word.id, { ...word, count: 1 });
  }));
  return { sequences, entries: [...entriesById.values()] };
}

export function buildAnnotationHierarchy(trackAnnotation, track, categories) {
  if (!trackAnnotation || !track) return { nodes: [], edges: [], maxLevel: 0 };
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const nodes = [];
  const edges = [];
  const keysByLevel = [];
  const noteById = new Map(track.events.map((note) => [note.id, note]));
  const noteIndexById = new Map(trackAnnotation.noteIds.map((id, index) => [id, index]));
  trackAnnotation.layers.forEach((layer, level) => {
    keysByLevel[level] = layer.segments.map((segment) => {
      const key = `${level}:${segment.id}`;
      nodes.push({ key, level, word: annotationWord(segment, trackAnnotation, level, categoryById, noteById, noteIndexById) });
      return { key, segment };
    });
  });
  for (let level = 1; level < keysByLevel.length; level++) {
    const lower = keysByLevel[level - 1];
    const lowerById = new Map(lower.map((child) => [child.segment.id, child]));
    for (const parent of keysByLevel[level]) {
      const sourceIds = parent.segment.sourceSegmentIds ?? [];
      const linked = trackAnnotation.layers[level].role === 'top' ? [] : sourceIds.map((id) => lowerById.get(id)).filter(Boolean);
      const parentNotes = new Set(parent.segment.noteIds);
      const children = linked.length ? linked : lower.filter((child) => child.segment.noteIds.some((id) => parentNotes.has(id)));
      for (const child of children) edges.push({ parentKey: parent.key, childKey: child.key });
    }
  }
  return { nodes, edges, maxLevel: Math.max(0, trackAnnotation.layers.length - 1) };
}

export function buildAnnotationExport({ song, midi, tracks, categories, tpb }) {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  return {
    schema: 'musicword-annotation',
    schemaVersion: 1,
    sourceId: midi?.sourceId,
    createdAt: new Date().toISOString(),
    song: { id: song?.id ?? midi?.id ?? '', name: song?.name ?? midi?.name ?? '' },
    timing: { sourcePpq: midi?.sourcePpq ?? null, displayTicksPerBeat: tpb },
    categories,
    tracks: tracks.map((track) => {
      const sourceTrack = midi?.tracks?.find((item) => item.id === track.trackId);
      return {
      trackId: track.trackId,
      signature: sourceTrack?.signature,
      name: sourceTrack?.name ?? track.trackId,
      instrument: sourceTrack?.instrument ?? '',
      channel: sourceTrack?.channel ?? null,
      notes: sourceTrack?.notes ?? track.noteIds.map((id) => ({ id })),
      layers: track.layers.map((layer, level) => ({
        level,
        id: layer.id,
        name: layer.name,
        role: layer.role,
        complete: layerCoverage(track, level).complete,
        words: layer.segments.map((segment) => ({
          id: segment.id,
          categoryId: segment.categoryId,
          categoryLabel: categoryById.get(segment.categoryId)?.label ?? segment.categoryId,
          noteIds: segment.noteIds,
          sourceWordIds: layer.role === 'top' && !segment.automatic
            ? sourceSegmentsForLevel(track, level).map((source) => source.id)
            : segment.sourceSegmentIds ?? [],
          automatic: Boolean(segment.automatic),
          ...(segment.assistance ? { assistance: segment.assistance } : {}),
        })),
      })),
    };
    }),
  };
}

export function prepareAnnotationTrack(track, scale) {
  return {
    ...track,
    events: track.notes.map((note) => ({
      ...note,
      onset: Math.round(note.ticks * scale),
      duration: Math.max(1, Math.round(note.durationTicks * scale)),
      pitch: note.midi,
    })),
  };
}

export function restoreAnnotationTracks(document, tracks) {
  const saved = new Map(document?.tracks.map((track) => [track.trackId, track]));
  const layerTemplate = document?.tracks[0]?.layers;
  return tracks.map((source) => {
    const track = createTrackAnnotation(source);
    const previous = saved.get(track.trackId);
    if (!previous) {
      if (layerTemplate) track.layers = layerTemplate.map(({ id, name, role }) =>
        track.layers.find((layer) => layer.id === id) ?? { id, name, role, segments: [] });
      return track;
    }
    if (previous.signature !== source.signature) throw new Error('标注音轨与源 MIDI 不一致');
    const orders = new Map(track.noteIds.map((id, index) => [id, index]));
    return {
      ...track,
      layers: previous.layers.map((layer) => ({
        id: layer.id, name: layer.name, role: layer.role,
        segments: layer.words.map((word) => ({
          id: word.id, categoryId: word.categoryId, noteIds: word.noteIds,
          sourceSegmentIds: word.sourceWordIds, automatic: word.automatic,
          ...(word.assistance ? { assistance: word.assistance } : {}),
          order: Math.min(...word.noteIds.map((id) => {
            if (!orders.has(id)) throw new Error('标注引用了源 MIDI 中不存在的音符');
            return orders.get(id);
          })),
        })),
      })),
    };
  });
}

export function migrateLegacyAnnotation(document, midi) {
  if (document.timing?.sourcePpq !== midi.sourcePpq || !Array.isArray(document.tracks) || !document.tracks.length) {
    throw new Error('旧版标注的 MIDI 或时间网格不匹配');
  }
  const tracks = document.tracks.map((legacy) => {
    const track = midi.tracks.find((item) => legacy.trackId === `${midi.catalogId}:${item.index}`);
    if (!track || track.notes.length !== legacy.notes?.length) throw new Error('旧版标注的音轨与曲库不匹配');
    const noteIds = new Map(legacy.notes.map((note, index) => {
      const source = track.notes[index];
      if (['midi', 'ticks', 'durationTicks'].some((key) => note[key] !== source[key])) {
        throw new Error('旧版标注的音符与曲库不匹配');
      }
      return [note.id, source.id];
    }));
    return { ...legacy, trackId: track.id, signature: track.signature, notes: track.notes,
      layers: legacy.layers.map((layer) => ({ ...layer, words: layer.words.map((word) =>
        ({ ...word, noteIds: word.noteIds.map((id) => noteIds.get(id)) })) })),
    };
  });
  return { ...document, schema: 'musicword-annotation', sourceId: midi.sourceId, tracks };
}
