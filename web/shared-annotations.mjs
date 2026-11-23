const library = '/api/annotations';
const pop909Annotations = '/activebasis/annotations';
const pop909Sources = { dictionary: '音形字典', csv: '音符表' };

export function pop909Label({ id, name }) {
  return id === name ? id : `${id} · ${name}`;
}

export async function pop909Catalog() {
  const response = await fetch('/bpe/api/songs');
  if (!response.ok) throw new Error('无法读取 POP909 曲目列表。');
  return response.json();
}

export async function pop909MidiFile(id, label) {
  const response = await fetch(`/bpe/api/midi/${encodeURIComponent(id)}?raw=1`);
  if (!response.ok) throw new Error('无法读取该 POP909 曲目的 MIDI。');
  return new File([await response.blob()], `${label}.mid`, { type: 'audio/midi' });
}

export async function annotationRequest(path = '', options) {
  const response = await fetch(library + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '共享标注请求失败');
  return result;
}

export async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(parts.join(''));
}

export function annotationMidiFile(document) {
  const bytes = Uint8Array.from(atob(document.midi), (character) => character.charCodeAt(0));
  return new File([bytes], document.fileName || 'score.mid', { type: 'audio/midi' });
}

async function pop909AnnotationJson(path) {
  const response = await fetch(`${pop909Annotations}/${path}.json`);
  if (!response.ok) throw new Error('无法读取 POP909 已有标注。');
  return response.json();
}

function categoryColor(index) {
  const palette = ['#e7aa46', '#62b6cb', '#d884b7', '#8fca79', '#a89be8', '#e18763', '#72c4a1', '#d2bd65'];
  if (index < palette.length) return palette[index];
  const hue = index * 137.508 / 30;
  const channel = (offset) => {
    const k = (offset + hue) % 12;
    const value = .64 - .24 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function pop909TrackWords(track, instances) {
  const onsets = new Map();
  for (const note of track.notes) {
    const key = `${note.midi},${note.ticks}`;
    if (!onsets.has(key)) onsets.set(key, []);
    onsets.get(key).push(note);
  }
  return instances.map((instance, index) => {
    const tier = /^(\d+)层 · (.+)$/.exec(instance.group);
    const level = Number(tier?.[1] ?? 1);
    const categoryId = tier?.[2] ?? instance.group;
    const used = new Set();
    for (const [pitch, start, end] of instance.notes) {
      const candidates = onsets.get(`${pitch},${start}`);
      if (!candidates) throw new Error(`POP909 标注与 MIDI 音轨「${track.name}」的音符不一致。`);
      let closest, distance = Infinity;
      for (const note of candidates) {
        const error = Math.abs(note.ticks + note.durationTicks - end);
        if (!used.has(note.id) && error < distance) {
          closest = note;
          distance = error;
        }
      }
      // Historical templates sometimes repeat a note more times than it occurs in the MIDI.
      if (closest) used.add(closest.id);
    }
    return { level, word: {
      id: `pop909:${index}:${instance.id}`, categoryId, categoryLabel: categoryId,
      noteIds: [...used], automatic: false,
    } };
  });
}

async function pop909AnnotationDocument(song, packets, source) {
  const [response, file] = await Promise.all([
    fetch(`/bpe/api/midi/${encodeURIComponent(song.id)}`),
    pop909MidiFile(song.id, song.id),
  ]);
  if (!response.ok) throw new Error('无法读取 POP909 标注对应的 MIDI 音轨。');
  const midi = await response.json();
  const byIndex = new Map(song.tracks.map(({id}, index) => [id, packets[index]]));
  const categories = new Map();
  const levels = new Set();
  const wordsByTrack = midi.tracks.map((track) => {
    const packet = byIndex.get(track.index);
    const instances = packet?.versions[source]?.instances ?? [];
    if (!instances.length) return [];
    if (packet.resolution !== midi.sourcePpq) throw new Error('POP909 标注与 MIDI 的每拍刻度不一致。');
    const words = pop909TrackWords(track, instances);
    for (const {level, word: {categoryId}} of words) {
      levels.add(level);
      if (!categories.has(categoryId)) categories.set(categoryId, {
        id: categoryId, label: `词类 ${categoryId}`, color: categoryColor(categories.size),
      });
    }
    return words;
  });
  if (!levels.size) throw new Error('该曲目的 POP909 标注没有可加载的片段。');
  const tiers = [...levels].sort((a, b) => a - b);
  const tracks = midi.tracks.map(({id: trackId, signature, name, instrument, channel, notes}, index) => {
    const noteIds = notes.map((note) => note.id);
    const layers = [{
      id: 'notes', name: '音符层', role: 'bottom', complete: true,
      words: noteIds.map((id) => ({ id: `note:${id}`, categoryId: 'NOTE', noteIds: [id], automatic: true })),
    }];
    for (const tier of tiers) {
      const words = wordsByTrack[index].filter(({level}) => level === tier).map(({word}) => word);
      const name = pop909Sources[source] + (tiers.length > 1 ? ` · 第 ${tier} 层` : '');
      layers.push({
        id: `pop909-${source}-${tier}`, name, role: 'manual', words,
        complete: new Set(words.flatMap(({noteIds}) => noteIds)).size === notes.length,
      });
    }
    layers.push({
      id: 'song', name: '整首乐曲', role: 'top', complete: true,
      words: [{ id: `song:${trackId}`, categoryId: 'SONG', noteIds, automatic: true }],
    });
    return { trackId, signature, name, instrument, channel, notes, layers: layers.map((layer, level) => ({ ...layer, level })) };
  });
  for (const {id} of song.tracks) {
    if (!midi.tracks.some(({index}) => index === id)) throw new Error('POP909 标注引用了 MIDI 中不存在的音轨。');
  }
  return {
    schema: 'musicword-annotation', schemaVersion: 1, sourceId: midi.sourceId,
    song: { id: song.id, name: song.name }, timing: { sourcePpq: midi.sourcePpq, displayTicksPerBeat: 24 },
    categories: [...categories.values()], tracks, fileName: file.name, midi: await fileBase64(file),
  };
}

export function referenceLayers(document, tracks = document.tracks) {
  const layers = new Map();
  for (const track of tracks) {
    for (const layer of track.layers) {
      if (layer.words.some((word) => !word.automatic)) layers.set(layer.id, layer.name);
    }
  }
  return layers;
}

export function referenceTrack(reference, signature, trackId) {
  if (!reference || !signature) return null;
  const matches = reference.document.tracks.filter((track) => track.signature === signature);
  return matches.find((track) => track.trackId === trackId) ?? (matches.length === 1 ? matches[0] : null);
}

export function referenceSegments(reference, track) {
  const layer = track?.layers.find((item) => item.id === reference.layer);
  if (!layer) return [];
  const noteById = new Map(track.notes.map((note) => [note.id, note]));
  const categories = new Map(reference.document.categories.map((category) => [category.id, category]));
  return layer.words.filter((word) => !word.automatic).map((word) => ({
    ...word,
    notes: word.noteIds.map((id) => noteById.get(id)),
    color: categories.get(word.categoryId)?.color ?? '#a89be8',
  }));
}

export function roundEven(value) {
  const left = Math.floor(value);
  return value - left === 0.5 ? left + left % 2 : Math.round(value);
}

export function referenceWindow(segments) {
  let start = Infinity, end = -Infinity;
  for (const { notes } of segments) {
    for (const { ticks, durationTicks } of notes) {
      start = Math.min(start, ticks);
      end = Math.max(end, ticks + Math.max(1, durationTicks));
    }
  }
  return start < end ? [start, end] : null;
}

export function clipMidiNote(note, [left, right]) {
  const start = Math.max(left, note.ticks);
  const end = Math.min(right, note.ticks + Math.max(1, note.durationTicks));
  return start < end ? { ...note, ticks: start, durationTicks: end - start } : null;
}

export function quantizedNote(note, scale, round = roundEven, roundDuration = false) {
  const start = round(note.ticks * scale);
  const end = roundDuration
    ? start + round(note.durationTicks * scale)
    : round((note.ticks + note.durationTicks) * scale);
  return { start, end: Math.max(start + 1, end), pitch: note.midi, id: note.id };
}

export function projectWindowNote(note, window, scale, origin = window[0]) {
  const clipped = clipMidiNote(note, window);
  if (!clipped) return null;
  const left = roundEven((window[0] - origin) * scale);
  const right = Math.max(left + 1, roundEven((window[1] - origin) * scale));
  const projected = quantizedNote({ ...clipped, ticks: clipped.ticks - origin }, scale);
  const start = Math.min(projected.start, right - 1);
  return { ...projected, start, end: Math.min(right, Math.max(start + 1, projected.end)) };
}

// Order the note onsets once so each predicted interval only visits the notes inside it.
export function groupsInBoxes(notes, boxes) {
  const ordered = [...notes].sort((a, b) => a.start - b.start);
  return boxes.map(([left, low, right, high]) => {
    let first = 0;
    let end = ordered.length;
    while (first < end) {
      const middle = (first + end) >>> 1;
      if (ordered[middle].start < left) first = middle + 1;
      else end = middle;
    }
    const group = [];
    for (let index = first; index < ordered.length && ordered[index].start < right; index++) {
      const note = ordered[index];
      if (note.pitch >= low && note.pitch < high) group.push(note.id);
    }
    return group;
  });
}

export function fragmentCounts(manual, predictions) {
  const annotated = new Set(manual.flat());
  const groupKey = (ids) => JSON.stringify([...new Set(ids)].sort());
  const expected = new Set(manual.map(groupKey));
  const predicted = new Set();
  for (const group of predictions) {
    const covered = group.filter((id) => annotated.has(id));
    if (covered.length) predicted.add(groupKey(covered));
  }
  let matches = 0;
  for (const key of predicted) if (expected.has(key)) matches++;
  return { matches, manual: expected.size, predicted: predicted.size, covered: annotated.size };
}

export function noteBox(notes) {
  let left = Infinity, low = Infinity, right = -Infinity, high = -Infinity;
  for (const { start, end, pitch } of notes) {
    left = Math.min(left, start);
    low = Math.min(low, pitch);
    right = Math.max(right, end);
    high = Math.max(high, pitch + 1);
  }
  return [left, low, right, high];
}

export function comparisonTrack(notes, manual, predictions) {
  const labelsFor = (segments) => {
    const labels = new Map();
    for (const { noteIds, categoryId } of segments) {
      for (const id of noteIds) labels.set(id, String(categoryId));
    }
    return notes.map(({ id }) => labels.get(id) ?? '');
  };
  return {
    manualBoxes: manual.map(({ notes }) => noteBox(notes)),
    predictedBoxes: predictions.map(({ box }) => box),
    manualLabels: labelsFor(manual),
    predictedLabels: labelsFor(predictions),
  };
}

const percent = (value) => new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(value);
const decimal = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const metricNames = [
  ['Average IOU', '平均 IoU'], ['ARI', 'ARI'], ['Homogeneity', '同质性'],
  ['Completeness', '完整性'], ['V-Measure', 'V-Measure'],
];

export function formatScores({ matches, manual, predicted, covered }, scope) {
  if (!manual) return '当前音轨在所选层没有人工标注。';
  const precision = predicted ? matches / predicted : 0;
  return `${scope} · ${covered} 个已标注音符 · 精确匹配 ${matches}/${manual} · 精确率 ${percent(precision)} · 召回率 ${percent(matches / manual)} · F1 ${percent(2 * matches / (manual + predicted))}`;
}

export function mountMidiPicker(container, { input, onPreset }) {
  const doc = container.ownerDocument;
  const controls = doc.createElement('div');
  controls.className = 'workspace-midi-source';
  const label = doc.createElement('label');
  label.className = 'workspace-midi-control';
  const caption = doc.createElement('span');
  caption.textContent = '加载 MIDI';
  const select = doc.createElement('select');
  select.className = 'workspace-midi-picker';
  const current = doc.createElement('option');
  current.value = '';
  current.hidden = true;
  const upload = doc.createElement('button');
  upload.type = 'button';
  upload.className = 'workspace-midi-upload';
  upload.textContent = '上传文件';
  upload.title = '导入 MIDI 或 MusicXML';
  upload.disabled = input.disabled;
  upload.addEventListener('click', () => input.click());
  new MutationObserver(() => { upload.disabled = input.disabled; })
    .observe(input, { attributeFilter: ['disabled'] });
  let selected = '';
  function setSelection(value = '', name = '选择曲目') {
    current.textContent = name;
    selected = value;
    select.value = value;
  }
  function setPresets(options) {
    select.replaceChildren(current, ...options);
    select.value = selected;
  }
  select.addEventListener('change', () => onPreset(select.value));
  setPresets([]);
  setSelection();
  label.append(caption, select);
  controls.append(label, upload);
  container.append(controls);
  return { select, setPresets, setSelection };
}

export function mountAnnotationControls(container, { toolbar, onLoad, onChange, editing = false }) {
  const element = (tag, text, doc = container.ownerDocument) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  if (!container.ownerDocument.querySelector('link[data-shared-annotations]')) {
    const styles = element('link');
    styles.rel = 'stylesheet';
    styles.href = '/shared-annotations.css';
    styles.dataset.sharedAnnotations = '';
    container.ownerDocument.head.append(styles);
  }
  const panel = element('section');
  panel.className = 'shared-annotation-controls';
  const picker = element('div', '', toolbar.ownerDocument);
  picker.className = 'shared-annotation-picker';
  const load = element('button', '加载标注数据', toolbar.ownerDocument);
  load.type = 'button';
  const documents = element('div', '', toolbar.ownerDocument);
  documents.className = 'shared-annotation-menu';
  documents.setAttribute('popover', 'auto');
  documents.setAttribute('aria-label', '可加载的标注');
  load.popoverTargetElement = documents;
  picker.append(load, documents);
  toolbar.prepend(picker);
  const layers = element('select');
  layers.setAttribute('aria-label', '对照标注层');
  const status = element('output');
  status.setAttribute('aria-live', 'polite');
  const score = element('output');
  score.setAttribute('aria-live', 'polite');
  score.title = '仅使用所选层已标注的音符。预测片段的音符集合与人工片段完全一致时计为匹配。';
  const metrics = element('output');
  metrics.setAttribute('aria-live', 'polite');
  metrics.title = '平均 IoU 使用时间与音高矩形的一对一最优匹配。聚类指标在标注时间范围内按音符计算，未归类音符使用同一类别。';
  layers.hidden = true;
  panel.append(layers, status, score, metrics);
  container.append(panel);
  let current;
  let refreshing;
  let busy = false;
  let choosing = false;
  let alive = true;
  let comparison;

  function clearMetrics() {
    comparison?.abort();
    metrics.textContent = '';
  }

  const menuButton = (label, action) => {
    const button = element('button', label, toolbar.ownerDocument);
    button.type = 'button';
    button.addEventListener('click', action);
    return button;
  };
  const menuText = (message) => element('span', message, toolbar.ownerDocument);
  const menuHeading = (message) => {
    const title = menuText(message);
    title.className = 'annotation-menu-heading';
    return title;
  };
  function refresh() {
    if (refreshing || busy || choosing) return refreshing;
    if (!documents.firstChild) documents.textContent = '正在读取标注库…';
    refreshing = Promise.allSettled([annotationRequest(), pop909AnnotationJson('index')]).then(([saved, pop909]) => {
      if (!alive) return;
      const savedItems = saved.status === 'fulfilled'
        ? saved.value.map(({sourceId, song}) => menuButton(song.name, () => open(() => annotationRequest('/' + sourceId))))
        : [menuText(saved.reason.message)];
      const popItems = pop909.status === 'fulfilled'
        ? pop909.value.map((song) => menuButton(pop909Label(song), () => choosePop909Source(song)))
        : [menuText(pop909.reason.message)];
      if (!savedItems.length) savedItems.push(menuText('在「标注」页保存后即可加载。'));
      documents.replaceChildren(menuHeading('已保存标注'), ...savedItems, menuHeading('POP909 已有标注'), ...popItems);
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function choosePop909Source(song) {
    if (busy || choosing) return;
    choosing = true;
    documents.replaceChildren(menuText('正在读取标注来源…'));
    try {
      const packets = await Promise.all(song.tracks.map(({key}) => pop909AnnotationJson(key)));
      if (!alive || !documents.matches(':popover-open')) return;
      const sources = Object.entries(pop909Sources).filter(([key]) =>
        packets.some(({versions}) => versions[key]?.instances.length));
      const choose = (source) => open(() => pop909AnnotationDocument(song, packets, source));
      if (sources.length === 1) return choose(sources[0][0]);
      if (!sources.length) throw new Error('该曲目没有可加载的标注片段。');
      const choices = sources.map(([key, name]) => menuButton(name, () => choose(key)));
      documents.replaceChildren(menuHeading(pop909Label(song)), ...choices, menuButton('返回标注列表', refresh));
      choices[0].focus();
    } catch (error) {
      documents.replaceChildren(menuText(error.message), menuButton('返回标注列表', refresh));
    } finally {
      choosing = false;
    }
  }

  const notify = () => onChange?.(current && { document: current, layer: layers.value });
  function setLayers(options, preferred = '') {
    const entries = [...options];
    if (entries.length !== layers.length ||
        entries.some(([id, name], index) => layers[index].value !== id || layers[index].text !== name)) {
      layers.replaceChildren(...entries.map(([id, name]) => new Option(name, id)));
    }
    layers.hidden = editing || !entries.length;
    layers.value = options.has(preferred) ? preferred : entries[0]?.[0] ?? '';
    return layers.value;
  }
  function clear(message = '') {
    current = null;
    layers.hidden = true;
    status.textContent = message;
    score.textContent = '';
    clearMetrics();
    notify();
  }
  async function open(loadDocument) {
    if (busy) return;
    documents.hidePopover();
    busy = load.disabled = layers.disabled = true;
    clearMetrics();
    score.textContent = '';
    try {
      status.textContent = '正在读取标注与 MIDI…';
      const next = await loadDocument();
      if (!alive) return;
      await onLoad(next, annotationMidiFile(next));
      if (!alive) return;
      current = next;
      const options = referenceLayers(next);
      setLayers(options);
      notify();
      status.textContent = editing ? `已打开 ${current.song.name}` :
        options.size ? `已加载 ${current.song.name}` : '此曲目尚无人工标注片段。';
    } catch (error) {
      clear(error.message || '加载标注失败');
    } finally {
      busy = load.disabled = layers.disabled = false;
    }
  }
  layers.addEventListener('change', notify);
  load.addEventListener('click', refresh);
  return {
    setTrackLayers(track) {
      const options = current && track ? referenceLayers(current, [track]) : new Map();
      return setLayers(options, layers.value);
    },
    setScore(message) {
      clearMetrics();
      score.textContent = message;
    },
    async compare(tracks, { retainResult = false } = {}) {
      clearMetrics();
      metrics.textContent = '正在计算标注比对指标…';
      const controller = new AbortController();
      comparison = controller;
      try {
        const response = await fetch('/activebasis/workbench-api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'annotation-metrics', tracks }),
          signal: retainResult ? undefined : controller.signal,
        });
        const { result, error } = await response.json();
        if (!response.ok || !result) throw new Error(error || '指标计算失败。');
        if (!controller.signal.aborted) {
          metrics.textContent = metricNames.map(([key, name]) => `${name} ${decimal.format(result[key])}`).join(' · ');
        }
        return result;
      } catch (error) {
        if (!controller.signal.aborted) metrics.textContent = error.message;
      }
    },
    dispose() {
      alive = false;
      clearMetrics();
      picker.remove();
      panel.remove();
    },
  };
}
