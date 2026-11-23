(() => {
  const $ = (id) => document.getElementById(id);
  const previewAudio = globalThis.MusicWordPreview;
  const {
    TICKS, ROOTS, QUALITIES, QUALITY_ORDER, displayRoot, pitchName, chordName, chordToneNames,
    wordLength, compileWord, visitNotes, placeClips, insertAtBeat, moveToBeat, resizeClip, writeMidi,
  } = globalThis.LegoMusic;
  const words = globalThis.LEGO_LIBRARY.words.map(([id, name, notes]) => ({
    id, number: id, name, notes, beats: wordLength(notes), label: name.replaceAll('_', ' '),
  }));
  const wordById = new Map(words.map((word) => [word.id, word]));
  const libraryCards = new WeakMap();
  const libraries = {
    hw: {words},
    pop909: {load: loadPop909Library},
    saved: {load: loadSavedLibrary},
  };
  const presets = [
    ['流行 · I–V–vi–IV', [['C', 'maj', 4], ['G', 'maj', 4], ['A', 'min', 4], ['F', 'maj', 4]]],
    ['爵士 · ii–V–I', [['D', 'min7', 2], ['G', 'dom7', 2], ['C', 'maj7', 4]]],
    ['小调 · i–VI–III–VII', [['A', 'min', 4], ['F', 'maj', 4], ['C', 'maj', 4], ['G', 'maj', 4]]],
    ['十二小节蓝调', ['C', 'C', 'C', 'C', 'F', 'F', 'C', 'C', 'G', 'F', 'C', 'G'].map((root) => [root, 'dom7', 4])],
    ['作业示例 · HW-Music Pattern', globalThis.LEGO_LIBRARY.example],
    ['大调终止 · I–IV–V–I', [['C', 'maj', 4], ['F', 'maj', 4], ['G', 'dom7', 4], ['C', 'maj', 4]]],
    ['大调七和弦 · I–vi–ii–V', [['C', 'maj7', 2], ['A', 'min7', 2], ['D', 'min7', 2], ['G', 'dom7', 2]]],
    ['流行 · vi–IV–I–V', [['A', 'min', 4], ['F', 'maj', 4], ['C', 'maj', 4], ['G', 'maj', 4]]],
    ['大调循环 · I–vi–IV–V', [['C', 'maj', 4], ['A', 'min', 4], ['F', 'maj', 4], ['G', 'dom7', 4]]],
    ['大调八和弦 · I–V–vi–iii–IV–I–IV–V', [
      ['C', 'maj', 4], ['G', 'maj', 4], ['A', 'min', 4], ['E', 'min', 4],
      ['F', 'maj', 4], ['C', 'maj', 4], ['F', 'maj', 4], ['G', 'maj', 4],
    ]],
    ['小调终止 · i–iv–V–i', [['A', 'min', 4], ['D', 'min', 4], ['E', 'dom7', 4], ['A', 'min', 4]]],
    ['爵士小调 · iiø–V–i', [['B', 'hdim7', 2], ['E', 'dom7', 2], ['A', 'min', 4]]],
    ['小调下行 · i–♭VII–♭VI–V', [['A', 'min', 4], ['G', 'maj', 4], ['F', 'maj', 4], ['E', 'dom7', 4]]],
    ['多利亚 · i–IV', [['D', 'min7', 4], ['G', 'dom7', 4], ['D', 'min7', 4], ['G', 'dom7', 4]]],
    ['混合利底亚 · I–♭VII–IV–I', [['G', 'maj', 4], ['F', 'maj', 4], ['C', 'maj', 4], ['G', 'maj', 4]]],
    ['爵士五度链 · iii–vi–ii–V–I', [
      ['E', 'min7', 2], ['A', 'min7', 2], ['D', 'min7', 2], ['G', 'dom7', 2], ['C', 'maj7', 4],
    ]],
    ['小调十二小节蓝调', [
      ['A', 'min7', 4], ['A', 'min7', 4], ['A', 'min7', 4], ['A', 'min7', 4],
      ['D', 'min7', 4], ['D', 'min7', 4], ['A', 'min7', 4], ['A', 'min7', 4],
      ['F', 'dom7', 4], ['E', 'dom7', 4], ['A', 'min7', 4], ['E', 'dom7', 4],
    ]],
  ].map(([label, steps]) => [label, steps.map(([root, quality, beats, octave = null]) => ({root, quality, beats, octave}))]);
  const octaves = [2, 3, 4, 5, 6];
  const harmonyOptions = {
    root: Object.keys(ROOTS).map((root) => [root, displayRoot(root)]),
    quality: QUALITY_ORDER.map((quality) => [quality, QUALITIES[quality][0] + ' · ' + quality]),
    octave: octaves.map((octave) => [octave, octave]),
  };
  const editedPresets = new Map();
  const flipModes = ['none', 'horizontal', 'vertical', 'diagonal'];
  const defaultDraft = {wordId: 1, root: 'C', quality: 'maj7', octave: 4, beats: 4, flip: 'none', density: 1, decay: 1, offset: 0};
  const storageKey = 'musicword.lego.v1';
  const fields = {
    flip: ['flip', String],
    density: ['density', Number], decay: ['decay', Number], beats: ['beats', Number],
    root: ['root', String], quality: ['quality', String], octave: ['octave', Number],
  };
  const multiplierOptions = {values: [.25, .5, 1, 2, 4], unit: '×', min: .125, max: 8};
  const numericChoices = {
    density: multiplierOptions,
    decay: multiplierOptions,
    beats: {values: [1, 2, 4, 8, 16], unit: ' 拍', min: 1, max: 16, integer: true},
  };
  const compiled = new WeakMap();
  const viewport = $('timeline-scroll');
  const timeline = $('timeline');
  const marker = $('insert-marker');
  const status = (text) => { $('status').textContent = text; };
  let draft = defaultDraft;
  let clips = [];
  let positions = [];
  let selectedId;
  let nextId = 1;
  let page = 0;
  let pageSize = 0;
  let insertionBeat = null;
  let beatSize = 76;
  let total = 0;
  let drag = null;
  let dragPoint = null;
  let dragFrame = 0;
  let rulerBeats = 16;
  let colors;
  let resizeGesture;

  function validNotes(notes) {
    return Array.isArray(notes) && notes.length > 0 && notes.every((note) => Array.isArray(note) &&
      note.length === 4 && note.every(Number.isSafeInteger) && note[0] >= 0 && note[1] > 0 &&
      note[2] >= 0 && note[2] <= 127 && note[3] > 0 && note[3] <= 127);
  }

  function validWord(clip) {
    const word = clip.annotationWord;
    if (!word) return wordById.has(clip.wordId);
    return typeof word.id === 'string' && word.id === clip.wordId && Number.isSafeInteger(word.number)
      && word.number > 0 && typeof word.label === 'string' && typeof word.name === 'string'
      && Number.isSafeInteger(word.beats) && word.beats > 0 && validNotes(word.notes);
  }

  function validChordStep(step) {
    return step && Object.hasOwn(ROOTS, step.root) && Object.hasOwn(QUALITIES, step.quality)
      && (step.octave === null || octaves.includes(step.octave))
      && Number.isSafeInteger(step.beats * TICKS) && Number.isInteger(step.beats) && step.beats >= 1;
  }

  function validClip(clip) {
    return validChordStep(clip) && validWord(clip) && clip.octave !== null
      && flipModes.includes(clip.flip) && [clip.density, clip.decay].every((factor) =>
        Number.isFinite(factor) && factor >= .125 && factor <= 8)
      && (clip.start === undefined || validStart(clip.start))
      && Number.isSafeInteger(clip.offset)
      && (!clip.imported || (typeof clip.imported.name === 'string' && validNotes(clip.imported.notes)));
  }

  function validStart(beat) {
    return Number.isSafeInteger(beat) && beat >= 0 && Number.isSafeInteger(beat * TICKS);
  }

  function migrateClip(clip) {
    if (!clip || typeof clip.flip !== 'boolean') return clip;
    const {attack, ...settings} = clip;
    return {...settings, flip: clip.flip ? 'vertical' : 'none', density: 1 / attack};
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved) return;
      const savedDraft = migrateClip(saved.draft);
      if (validClip(savedDraft)) draft = savedDraft;
      previewAudio.restoreBpm(saved.bpm);
      if (Array.isArray(saved.clips)) {
        clips = saved.clips.map(migrateClip).filter(validClip).map((clip) => ({...clip, id: nextId++}));
      }
      for (const [label, defaults] of presets) {
        const steps = saved.editedPresets?.[label];
        if (Array.isArray(steps) && steps.length === defaults.length && steps.every(validChordStep)) {
          editedPresets.set(label, steps);
        }
      }
    } catch { /* Session storage can be unavailable for a standalone file. */ }
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({draft, clips, editedPresets: Object.fromEntries(editedPresets)}));
    } catch { /* The open session still works. */ }
  }

  function makeElement(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function options(select, entries) {
    select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  }

  function wireNumericChoice(input, {values, unit, min, max, integer}) {
    const control = input.parentElement;
    const toggle = control.querySelector('button');
    const list = $(input.getAttribute('aria-controls'));
    const entries = values.map((value, index) => {
      const option = makeElement('div', value + unit, 'numeric');
      option.id = list.id + '-' + index;
      option.dataset.index = index;
      option.setAttribute('role', 'option');
      return option;
    });
    list.replaceChildren(...entries);
    let active = -1;

    function selectActive(index) {
      entries[active]?.removeAttribute('data-active');
      active = index;
      if (index < 0) input.removeAttribute('aria-activedescendant');
      else {
        entries[index].setAttribute('data-active', '');
        input.setAttribute('aria-activedescendant', entries[index].id);
      }
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      selectActive(-1);
    }

    function open(fallback = 0) {
      const selected = values.indexOf(current()[input.id]);
      for (const [index, entry] of entries.entries()) entry.setAttribute('aria-selected', String(index === selected));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      selectActive(selected < 0 ? fallback : selected);
    }

    function commitValue(reportError = false) {
      const previous = current()[input.id];
      const text = input.value.trim().replace(',', '.');
      const value = Number(text);
      const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)
        && value >= min && value <= max && (!integer || Number.isInteger(value));
      if (!valid && value !== previous && reportError) {
        input.setCustomValidity(integer ? '请输入 1 至 16 之间的整数拍数。' : '请输入 0.125 至 8 之间的倍率。');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      input.value = String(valid ? value : previous);
      if (valid && value !== previous) changeClip({[input.id]: value});
    }

    function choose(index) {
      input.value = String(values[index]);
      close();
      commitValue();
    }

    toggle.addEventListener('pointerdown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      input.focus({preventScroll: true});
      if (list.hidden) open();
      else close();
    });
    list.addEventListener('pointerdown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const option = event.target.closest('[data-index]');
      if (option) choose(Number(option.dataset.index));
    });
    input.addEventListener('input', () => {
      input.setCustomValidity('');
      close();
    });
    input.addEventListener('blur', () => {
      close();
      commitValue();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (list.hidden) open(step === 1 ? 0 : entries.length - 1);
        else selectActive(Math.max(0, Math.min(entries.length - 1, active + step)));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (list.hidden) commitValue(true);
        else choose(active);
      } else if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        close();
      }
    });
  }

  const current = () => clips.find((clip) => clip.id === selectedId) ?? draft;
  const newId = () => nextId++;
  const newClip = (settings) => ({...settings, start: undefined, id: newId()});
  const clipWord = (clip) => clip.annotationWord ?? wordById.get(clip.wordId);
  const wordSettings = (word) => ({wordId: word.id, annotationWord: typeof word.id === 'string' ? word : undefined, offset: 0});
  function getCompiled(clip) {
    if (clip.imported) return clip.imported;
    if (!compiled.has(clip)) compiled.set(clip, compileWord(clipWord(clip), clip));
    return compiled.get(clip);
  }

  function loadColors() {
    const style = getComputedStyle(document.documentElement);
    colors = Object.fromEntries(['roll-grid', 'roll-bar', 'muted', 'word', 'harmony', 'accent', 'ink', 'harmony-soft']
      .map((name) => [name, style.getPropertyValue('--' + name).trim()]));
    beatSize = parseFloat(style.getPropertyValue('--beat'));
  }

  function canvasContext(canvas) {
    const size = canvas.getBoundingClientRect();
    if (!size.width || !size.height) return;
    const width = size.width;
    const height = size.height;
    const ratio = Math.min(devicePixelRatio || 1, 2, 8192 / width);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    return {ctx, width, height};
  }

  function drawRoll(canvas, notes, beats, color, axes = false) {
    const drawing = canvasContext(canvas);
    if (!drawing) return;
    const {ctx, width, height} = drawing;
    let low = notes.length ? 127 : 60;
    let high = notes.length ? 0 : 71;
    for (const note of notes) {
      low = Math.min(low, note[2]);
      high = Math.max(high, note[2]);
    }
    if (high - low < 5) {
      high += 3;
      low -= 3;
    }
    const left = axes ? 35 : 2;
    const right = width - (axes ? 8 : 2);
    const top = axes ? 6 : 2;
    const bottom = height - (axes ? 17 : 2);
    const row = (bottom - top) / (high - low + 1);
    const tick = (right - left) / (beats * TICKS);
    const y = (pitch) => top + (high - pitch) * row;
    if (axes) {
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      for (let pitch = low; pitch <= high; pitch++) {
        const strong = pitch % 12 === 0;
        ctx.fillStyle = strong ? colors['roll-bar'] : colors['roll-grid'];
        ctx.fillRect(left, y(pitch) + row, right - left, 1);
        if ((strong || pitch === high || pitch === low) && (pitch >= 0 && pitch <= 127)) {
          ctx.fillStyle = colors.muted;
          ctx.fillText(pitchName(pitch), 7, y(pitch) + row / 2);
        }
      }
      const gridStep = Math.max(1, Math.ceil(beats / ((right - left) / 8)));
      const labelStep = gridStep * Math.max(1, Math.ceil(27 / ((right - left) / beats * gridStep)));
      for (let beat = 0; beat <= beats; beat += gridStep) {
        const x = left + beat * TICKS * tick;
        ctx.fillStyle = beat % 4 === 0 ? colors['roll-bar'] : colors['roll-grid'];
        ctx.fillRect(x, top, 1, bottom - top);
        if (beat < beats && beat % labelStep === 0) {
          ctx.fillStyle = colors.muted;
          ctx.fillText(String(beat + 1), x + 3, height - 7);
        }
      }
    }
    ctx.fillStyle = colors[color];
    for (const [start, duration, pitch, velocity] of notes) {
      const x = left + start * tick;
      ctx.globalAlpha = 0.57 + 0.43 * velocity / 127;
      ctx.fillRect(x, y(pitch) + Math.min(1, row / 5), Math.min(right - x, Math.max(1, duration * tick - 0.7)), Math.max(1, row * .72));
    }
    ctx.globalAlpha = 1;
  }

  function drawStaff(tones) {
    const canvas = $('chord-staff');
    canvas.setAttribute('aria-label', '和弦五线谱 ' + tones.join('、'));
    const drawing = canvasContext(canvas);
    if (!drawing) return;
    const {ctx, width, height} = drawing;
    const spelled = tones.map((tone) => ({
      position: Number(tone.at(-1)) * 7 + 'CDEFGAB'.indexOf(tone[0]),
      accidentals: tone.slice(1, -1),
    }));
    const bass = spelled[Math.floor(spelled.length / 2)].position < 28;
    const bottom = bass ? 18 : 30; // G2 or E4, the bottom line of each clef.
    const low = Math.min(bottom, spelled[0].position);
    const high = Math.max(bottom + 8, spelled.at(-1).position);
    const halfSpace = Math.min(7.5, (height - 32) / (high - low + 2));
    const y = (position) => height / 2 + ((low + high) / 2 - position) * halfSpace;
    const left = width * .1;
    const right = width * .9;
    const center = width * .58;
    function line(x1, x2, position, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y(position));
      ctx.lineTo(x2, y(position));
      ctx.stroke();
    }
    for (let step = 0; step <= 8; step += 2) line(left, right, bottom + step, colors.muted);
    ctx.fillStyle = colors.ink;
    ctx.textBaseline = 'middle';
    ctx.font = (halfSpace * (bass ? 7.6 : 10.5)) + 'px "Noto Music", "Segoe UI Symbol", serif';
    ctx.fillText(bass ? '\u{1D122}' : '\u{1D11E}', left + 8, y(bottom + (bass ? 4 : 3)));
    const head = Math.max(5, halfSpace * 1.35);
    let priorX = center;
    for (const [index, note] of spelled.entries()) {
      const stage = note.position;
      const x = spelled[index - 1]?.position === stage - 1 && priorX === center ? center + head * 1.45 : center;
      for (let pos = bottom - 2; pos >= stage; pos -= 2) line(x - head - 4, x + head + 4, pos, colors.ink);
      for (let pos = bottom + 10; pos <= stage; pos += 2) line(x - head - 4, x + head + 4, pos, colors.ink);
      ctx.beginPath();
      ctx.ellipse(x, y(stage), head, halfSpace * .75, -.17, 0, 2 * Math.PI);
      ctx.fillStyle = colors.ink;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x, y(stage), head * .46, halfSpace * .4, -.17, 0, 2 * Math.PI);
      ctx.fillStyle = colors['harmony-soft'];
      ctx.fill();
      if (note.accidentals) {
        ctx.fillStyle = colors.ink;
        ctx.font = Math.max(11, halfSpace * 2.5) + 'px "Segoe UI Symbol", sans-serif';
        ctx.fillText(note.accidentals, center - head - 5 - ctx.measureText(note.accidentals).width, y(stage));
      }
      priorX = x;
    }
  }

  function rollNotes(clip, beats) {
    const notes = [];
    visitNotes(getCompiled(clip), clip, 0, beats * TICKS, (note) => notes.push(note));
    return notes;
  }

  const libraryPageSize = () => 4 * Number(getComputedStyle($('word-list')).getPropertyValue('--library-columns'));

  function wordsByCategory(source, song, track, layer, ppq, instances) {
    const groups = new Map();
    for (const {category, label, notes} of instances) {
      if (!notes.length) continue;
      const start = notes.reduce((first, [on]) => Math.min(first, on), Infinity);
      const prior = groups.get(category);
      if (!prior || start < prior.start) groups.set(category, {start, label, notes, count: (prior?.count ?? 0) + 1});
      else prior.count++;
    }
    return [...groups].map(([category, {start, label, notes, count}]) => {
      const scale = TICKS / ppq;
      const pattern = notes.map(([on, off, pitch, velocity]) => {
        const onset = Math.round((on - start) * scale);
        return [onset, Math.max(1, Math.round((off - start) * scale) - onset), pitch,
          Number.isFinite(velocity) ? Math.max(1, Math.min(127, Math.round(velocity))) : 90];
      }).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
      return {
        id: JSON.stringify([source, song.id, track.id, layer.id, category]),
        songId: song.id, songLabel: song.label,
        label, name: [song.label, track.label, layer.label, label].join(' · '),
        count, notes: pattern, beats: wordLength(pattern),
      };
    });
  }

  async function readLibraryJson(url) {
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok) throw new Error('音词库读取失败，请重新选择来源。');
    return response.json();
  }

  async function loadPop909Library() {
    const path = '/activebasis/annotations/';
    const songs = await readLibraryJson(path + 'index.json');
    const tracks = songs.flatMap((song) => song.tracks.map((track) => ({song, track})));
    const dictionary = [];
    for (let i = 0; i < tracks.length; i += 8) {
      const packets = await Promise.all(tracks.slice(i, i + 8).map(async ({song, track}) => {
        const {resolution, versions} = await readLibraryJson(path + encodeURIComponent(track.key) + '.json');
        const songInfo = {id: song.id, label: song.id === song.name ? song.id : song.id + ' · ' + song.name};
        const trackInfo = {id: track.key, label: '音轨 ' + (track.id + 1)};
        return Object.entries(versions).flatMap(([version, {instances}]) =>
          wordsByCategory('pop909', songInfo, trackInfo,
            {id: version, label: version === 'dictionary' ? '音形字典' : '音符表'}, resolution,
            instances.map(({group, notes}) => ({
              category: group, label: /^\d+$/.test(group) ? '词类 ' + group : group,
              notes: notes.map(([pitch, start, end]) => [start, end, pitch]),
            }))));
      }));
      for (const packet of packets) dictionary.push(...packet);
    }
    return dictionary;
  }

  async function loadSavedLibrary() {
    const api = await import('/shared-annotations.mjs');
    const entries = await api.annotationRequest('', {cache: 'no-store'});
    const documents = await Promise.all(entries.map(({sourceId}) =>
      api.annotationRequest('/' + encodeURIComponent(sourceId), {cache: 'no-store'})));
    return documents.flatMap((document) => {
      const song = {id: document.sourceId, label: document.song.name};
      const labels = new Map(document.categories.map((category) => [category.id, category.label]));
      return document.tracks.flatMap((track) => {
        const noteById = new Map(track.notes.map((note) => [note.id, note]));
        return track.layers.filter((layer) => layer.role === 'manual').flatMap((layer) =>
          wordsByCategory('saved', song, {id: track.trackId, label: track.name},
            {id: layer.id, label: layer.name}, document.timing.sourcePpq,
            layer.words.filter((word) => !word.automatic).map((word) => ({
              category: word.categoryId, label: labels.get(word.categoryId) ?? word.categoryLabel ?? word.categoryId,
              notes: word.noteIds.map((id) => noteById.get(id)).filter(Boolean)
                .map(({ticks, durationTicks, midi, velocity}) => [ticks, ticks + durationTicks, midi, velocity]),
            }))));
      });
    });
  }

  function updateSongFilter() {
    const select = $('library-song');
    const currentSong = select.value;
    const entries = libraries[$('library-source').value].words ?? [];
    const songs = new Map(entries.filter((word) => word.songId).map((word) => [word.songId, word.songLabel]));
    options(select, [['', '全部曲目'], ...songs]);
    select.value = songs.has(currentSong) ? currentSong : '';
    select.hidden = !songs.size;
  }

  async function loadLibrary(source) {
    const library = libraries[source];
    if (!library.load || library.loading || (library.words && source === 'pop909')) return;
    library.error = '';
    library.loading = true;
    renderLibrary();
    try {
      if (location.protocol === 'file:') throw new Error('请从 MusicWord 工作台打开标注词典。');
      library.words = (await library.load()).map((word, index) => ({...word, number: index + 1}));
    } catch (error) {
      library.error = error.message || '无法读取音词。';
    } finally {
      library.loading = false;
      if ($('library-source').value === source) {
        updateSongFilter();
        renderLibrary();
      }
    }
  }

  function dictionaryWords() {
    const library = libraries[$('library-source').value];
    const song = $('library-song').value;
    return (library.words ?? []).filter((word) => !song || song === word.songId);
  }

  function renderLibrary() {
    const nextSize = libraryPageSize();
    page = Math.floor(page * pageSize / nextSize);
    pageSize = nextSize;
    const search = $('search').value.toLowerCase().trim().replace(/^#/, '');
    const library = libraries[$('library-source').value];
    const entries = dictionaryWords();
    const matching = entries.filter((word) =>
      word.label.toLowerCase().includes(search) || word.name.toLowerCase().includes(search) || String(word.number) === search);
    const pages = Math.max(1, Math.ceil(matching.length / pageSize));
    page = Math.min(page, pages - 1);
    $('word-count').textContent = search ? matching.length + ' 条匹配' : entries.length + ' 个音词';
    $('page-count').textContent = (page + 1) + ' / ' + pages;
    $('previous-page').disabled = page === 0;
    $('next-page').disabled = page + 1 === pages;

    const items = matching.slice(page * pageSize, (page + 1) * pageSize).map((word) => {
      const button = makeElement('button', undefined, 'word-card');
      button.type = 'button';
      button.draggable = true;
      button.dataset.word = word.id;
      libraryCards.set(button, word);
      const detail = word.count ? word.name + ' · ' + word.count + ' 次' : word.label;
      button.title = detail + ' · 悬停试听，点击选用或拖入';
      button.setAttribute('aria-label', '音词 ' + word.number + '，' + detail + '，' + word.beats + ' 拍');
      const canvas = makeElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const label = makeElement('span');
      label.append(makeElement('small', '#' + word.number), makeElement('strong', word.label));
      if (word.count) label.append(makeElement('small', '×' + word.count, 'word-frequency'));
      button.append(canvas, label);
      return button;
    });
    const empty = library.loading ? '正在读取标注词典…' : library.error ||
      (search ? '没有找到音词' : '这里还没有标注音词');
    $('word-list').replaceChildren(...(items.length ? items : [makeElement('p', empty)]));
    paintLibrary();
    indicateWord();
  }

  function paintLibrary() {
    for (const button of $('word-list').querySelectorAll('[data-word]')) {
      const word = libraryCards.get(button);
      drawRoll(button.querySelector('canvas'), word.notes, word.beats, 'word');
    }
  }

  function indicateWord() {
    for (const button of $('word-list').querySelectorAll('[data-word]')) {
      button.setAttribute('aria-pressed', String(!current().imported && libraryCards.get(button).id === current().wordId));
    }
  }

  function selectLibraryWord(word) {
    if (current().imported) {
      selectedId = undefined;
      renderTimeline();
    }
    changeClip(wordSettings(word));
  }

  function paintEditor(clip) {
    const displayBeats = clip.beats;
    document.querySelector('.ingredients').hidden = Boolean(clip.imported);
    $('result-title').textContent = clip.imported ? '导入片段' : '音词事件实例';
    if (clip.imported) {
      $('result-description').textContent = clip.imported.name + ' · ' + clip.beats + ' 拍';
      drawRoll($('result-roll'), rollNotes(clip, displayBeats), displayBeats, 'harmony', true);
      indicateWord();
      return;
    }
    const word = clipWord(clip);
    const transformed = compileWord(word, clip, false);
    const name = chordName(clip);
    $('word-id').textContent = '#' + word.number;
    $('word-name').textContent = word.label;
    $('word-name').title = word.name;
    const cycle = transformed.period / TICKS;
    $('word-length').textContent = '原长 ' + word.beats + ' 拍' + (cycle === word.beats ? '' : ' · 变奏 ' + cycle + ' 拍');
    drawRoll($('word-roll'), transformed.notes, cycle, 'word', true);
    $('chord-name').textContent = name;
    const tones = chordToneNames(clip);
    $('chord-notes').replaceChildren(...tones.map((name) => makeElement('span', name)));
    drawStaff(tones);
    const description = '#' + word.number + ' · ' + name + ' · ' + clip.beats + ' 拍';
    $('result-description').textContent = description;
    drawRoll($('result-roll'), rollNotes(clip, displayBeats), displayBeats, 'harmony', true);
    indicateWord();
  }

  function renderEditor(syncFields = true) {
    const clip = current();
    const index = clips.indexOf(clip);
    const editing = index >= 0;
    $('clip-actions').hidden = !editing;
    $('editor-mode').toggleAttribute('data-editing', editing);
    $('editor-mode').textContent = editing ? '编辑第 ' + (positions[index].start + 1) + ' 拍' : '草稿';
    if (syncFields) {
      for (const [id, [key]] of Object.entries(fields)) {
        $(id).value = String(clip[key]);
        $(id).setCustomValidity('');
      }
    }
    paintEditor(clip);
  }

  function renderRuler() {
    const width = viewport.clientWidth;
    const first = Math.max(0, Math.floor(viewport.scrollLeft / beatSize));
    const last = first + Math.ceil(width / beatSize) + 1;
    const labels = [];
    for (let beat = first; beat <= last && beat * beatSize < timeline.offsetWidth - 18; beat++) {
      const label = makeElement('span', beat + 1, 'numeric');
      label.style.left = beat * beatSize + 'px';
      labels.push(label);
    }
    $('ruler').replaceChildren(...labels);
    timeline.style.setProperty('--viewport-width', width + 'px');
  }

  function renderMarker(beat = insertionBeat) {
    marker.hidden = beat === null;
    if (beat === null) return;
    marker.style.left = beat * beatSize + 'px';
    marker.firstElementChild.textContent = '第 ' + (beat + 1) + ' 拍';
  }

  const clipTitle = (clip) => clip.imported?.name ?? ('音词' + clipWord(clip).number + ' x ' + chordName(clip));

  function paintClipFrame(element, {clip, start}) {
    element.style.left = start * beatSize + 2 + 'px';
    element.style.width = clip.beats * beatSize - 4 + 'px';
    const body = element.querySelector('.clip-body');
    const source = clip.annotationWord ? ' · ' + clip.annotationWord.name : '';
    body.title = '第 ' + (start + 1) + '–' + (start + clip.beats) + ' 拍 · ' + clipTitle(clip) + source;
    body.querySelector('small').textContent = (clip.imported ? 'MIDI · ' : '') + clip.beats + ' 拍';
  }

  function paintClipRoll(element, clip) {
    drawRoll(element.querySelector('canvas'), rollNotes(clip, clip.beats), clip.beats, 'word');
  }

  function paintClipSelection(element, clipId) {
    const selected = clipId === selectedId;
    element.toggleAttribute('data-selected', selected);
    element.querySelector('.clip-body').setAttribute('aria-pressed', String(selected));
  }

  function renderTimeline() {
    positions = placeClips(clips).map(({clip, start, end}) =>
      ({clip: clip.start === start ? clip : {...clip, start}, start, end}));
    clips = positions.map(({clip}) => clip);
    total = positions.at(-1)?.end ?? 0;
    const focused = document.activeElement;
    const focusedClip = focused?.closest('[data-clip]')?.dataset.clip;
    const focusSelector = focused?.dataset.edge ? '[data-edge="' + focused.dataset.edge + '"]' : '.clip-body';
    extendRuler(Math.max(total, insertionBeat ?? 0));
    const entries = positions.map((position) => {
      const {clip} = position;
      const frame = makeElement('div', undefined, 'clip');
      frame.dataset.clip = clip.id;
      const button = makeElement('button', undefined, 'clip-body');
      button.type = 'button';
      button.draggable = true;
      const name = clipTitle(clip);
      const canvas = makeElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      button.append(
        makeElement('strong', name),
        makeElement('small', undefined, 'numeric'),
        canvas,
      );
      frame.append(button);
      for (const [edge, title] of [['start', '调整片段左端'], ['end', '调整片段右端']]) {
        const handle = makeElement('button', undefined, 'clip-edge');
        handle.type = 'button';
        handle.dataset.edge = edge;
        handle.title = title;
        handle.setAttribute('aria-label', title + ' · ' + name);
        frame.append(handle);
      }
      paintClipSelection(frame, clip.id);
      paintClipFrame(frame, position);
      return {frame, clip};
    });
    $('clips').replaceChildren(...entries.map(({frame}) => frame));
    for (const {frame, clip} of entries) paintClipRoll(frame, clip);
    if (focusedClip) $('clips').querySelector('[data-clip="' + focusedClip + '"] ' + focusSelector)?.focus({preventScroll: true});
    $('sequence-count').textContent = clips.length + ' 段 · ' + total + ' 拍';
    $('empty-track').hidden = clips.length > 0;
    $('export').disabled = !clips.length;
    renderRuler();
    renderMarker();
    updateTransport();
  }

  function commit(message, syncFields = true) {
    cancelPlayback();
    renderTimeline();
    renderEditor(syncFields);
    save();
    if (message) status(message);
  }

  function changeClip(changes, syncFields = true) {
    const previous = current();
    const replacement = {...previous, ...changes};
    if (!validClip(replacement)) return;
    if (selectedId === undefined) {
      draft = replacement;
      cancelPlayback();
      renderEditor(syncFields);
      save();
    } else {
      clips = clips.filter((clip) => clip !== previous);
      if (previous.beats === replacement.beats) clips.push(replacement);
      else clips = insertAtBeat(clips, previous.start, replacement, newId);
      commit(undefined, syncFields);
    }
  }

  function revealAdded(fromBeat) {
    const start = fromBeat * beatSize;
    const end = total * beatSize;
    const width = viewport.clientWidth;
    const left = viewport.scrollLeft;
    if (start < left || start >= left + width - beatSize / 2) {
      viewport.scrollLeft = start;
    } else if (end > left + width && end - start < width) {
      viewport.scrollLeft = Math.max(0, end - width + 8);
    }
  }

  function addSegment(beat) {
    const incoming = newClip(current());
    clips = insertAtBeat(clips, beat, incoming, newId);
    commit('已在第 ' + (beat + 1) + ' 拍加入 ' + incoming.beats + ' 拍');
  }

  function relocateClip(id, beat) {
    if (!validStart(beat)) return;
    const moved = moveToBeat(clips, id, beat, newId);
    if (moved === clips) return;
    clips = moved;
    selectedId = id;
    commit('已移到第 ' + (beat + 1) + ' 拍');
    revealAdded(beat);
  }

  function getPreset(index = Number($('preset').value)) {
    const [label, defaults] = presets[index];
    return {label, steps: editedPresets.get(label) ?? defaults};
  }

  function renderPreset() {
    const {label, steps} = getPreset();
    const rows = steps.map((step, index) => {
      const row = makeElement('tr');
      row.dataset.step = index;
      const number = makeElement('th', index + 1, 'numeric');
      number.scope = 'row';
      row.append(number);
      for (const [key, name] of [['root', '根音'], ['quality', '和弦质'], ['octave', '八度'], ['beats', '拍数']]) {
        const cell = makeElement('td');
        const input = makeElement(key === 'beats' ? 'input' : 'select');
        input.dataset.field = key;
        input.setAttribute('aria-label', '第 ' + (index + 1) + ' 步' + name);
        if (key === 'beats') {
          input.type = 'number';
          input.min = 1;
          input.step = 1;
          input.inputMode = 'numeric';
        } else {
          const choices = harmonyOptions[key];
          options(input, key === 'octave' ? [['', '随片段'], ...choices] : choices);
        }
        input.value = step[key] ?? '';
        cell.append(input);
        row.append(cell);
      }
      return row;
    });
    $('preset-steps').replaceChildren(...rows);
    $('reset-preset').disabled = !editedPresets.has(label);
  }

  function editPresetStep(input) {
    const field = input.dataset.field;
    const row = input.closest('[data-step]');
    if (!row || !field || !input.validity.valid) return;
    const index = Number(row.dataset.step);
    const {label, steps} = getPreset();
    const value = field === 'beats' ? Number(input.value)
      : field === 'octave' ? (input.value ? Number(input.value) : null)
        : input.value;
    const edited = {...steps[index], [field]: value};
    if (!validChordStep(edited) || edited[field] === steps[index][field]) return;
    editedPresets.set(label, steps.map((step, position) => position === index ? edited : step));
    $('reset-preset').disabled = false;
    save();
  }

  function insertPreset() {
    const template = current().imported ? draft : current();
    const {label, steps} = getPreset();
    const from = total;
    clips = [...clips, ...steps.map((step) =>
      newClip({...template, ...step, octave: step.octave ?? template.octave, offset: 0}))];
    commit('已加入' + label + '的 ' + steps.length + ' 个片段');
    revealAdded(from);
  }

  const randomItem = (values) => values[Math.floor(Math.random() * values.length)];
  function addRandomSection() {
    const {label, steps} = getPreset(Math.floor(Math.random() * presets.length));
    const template = current().imported ? draft : current();
    const availableWords = dictionaryWords();
    const pool = availableWords.length ? availableWords : words;
    const factors = [.5, .75, 1, 1.25, 1.5, 2];
    const length = 64;
    const count = Math.ceil(8 / steps.length) * steps.length;
    let remaining = length;
    clips = Array.from({length: count}, (_, index) => {
      const slots = count - index - 1;
      const min = Math.max(1, remaining - 16 * slots);
      const max = Math.min(16, remaining - slots);
      const beats = min + Math.floor(Math.random() * (max - min + 1));
      remaining -= beats;
      const {root, quality, octave} = steps[index % steps.length];
      return newClip({
        ...wordSettings(randomItem(pool)), root, quality, octave: octave ?? template.octave,
        beats, flip: randomItem(flipModes), density: randomItem(factors), decay: randomItem(factors),
      });
    });
    selectedId = undefined;
    insertionBeat = null;
    commit('已生成「' + label + '」，' + count + ' 段，共 ' + length + ' 拍');
    viewport.scrollLeft = 0;
  }

  function beatAt(clientX) {
    return Math.max(0, Math.round((clientX - timeline.getBoundingClientRect().left) / beatSize));
  }

  function extendRuler(beat) {
    rulerBeats = Math.max(rulerBeats, beat + 8);
    timeline.style.setProperty('--track-width', rulerBeats * beatSize + 'px');
  }

  function pickBeat(beat, reveal = false) {
    if (!validStart(beat)) return;
    insertionBeat = beat;
    extendRuler(beat);
    if (reveal) {
      const x = beat * beatSize;
      if (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth - beatSize) {
        viewport.scrollLeft = Math.max(0, x - beatSize);
      }
    }
    renderMarker();
    status('已选第 ' + (beat + 1) + ' 拍');
  }

  function beginDrag(event, kind, id) {
    stopHover();
    drag = {kind, id};
    event.dataTransfer.effectAllowed = kind === 'move' ? 'move' : 'copy';
    event.dataTransfer.setData('text/plain', 'MusicWord LEGO');
  }

  function endDrag() {
    drag = null;
    dragPoint = null;
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    $('word-drop').classList.remove('drop-over');
    renderMarker();
  }

  function scrollTrackAt(clientX) {
    const bounds = viewport.getBoundingClientRect();
    const distance = 38;
    if (clientX > bounds.right - distance) {
      extendRuler(Math.ceil((viewport.scrollLeft + viewport.clientWidth) / beatSize));
      viewport.scrollLeft += 12;
    }
    if (clientX < bounds.left + distance) viewport.scrollLeft -= 12;
  }

  function scrollWhileDragging() {
    if (dragPoint === null) return;
    scrollTrackAt(dragPoint);
    renderMarker(beatAt(dragPoint));
    dragFrame = requestAnimationFrame(scrollWhileDragging);
  }

  function beginResize(event) {
    const handle = event.target.closest('[data-edge]');
    if (!handle || event.button !== 0 || resizeGesture) return;
    const id = Number(handle.closest('[data-clip]').dataset.clip);
    const position = positions.find(({clip}) => clip.id === id);
    if (!position) return;
    event.preventDefault();
    cancelPlayback();
    selectedId = id;
    handle.focus({preventScroll: true});
    handle.setPointerCapture(event.pointerId);
    const elements = new Map([...$('clips').children].map((frame) => [Number(frame.dataset.clip), frame]));
    for (const [clipId, frame] of elements) paintClipSelection(frame, clipId);
    renderEditor();
    elements.get(id).setAttribute('data-resizing', '');
    viewport.setAttribute('data-resizing', '');
    resizeGesture = {
      id, elements, edge: handle.dataset.edge, pointer: event.pointerId,
      initialX: event.clientX, initialScroll: viewport.scrollLeft, x: event.clientX,
      boundary: position[handle.dataset.edge], resized: clips, frame: 0,
    };
  }

  function paintResizing(gesture) {
    const delta = (gesture.x - gesture.initialX + viewport.scrollLeft - gesture.initialScroll) / beatSize;
    const target = gesture.boundary + Math.round(delta);
    if (target === gesture.target) return;
    gesture.target = target;
    gesture.resized = resizeClip(clips, gesture.id, gesture.edge, target);
    const layout = placeClips(gesture.resized);
    extendRuler(layout.at(-1).end);
    for (const position of layout) {
      const element = gesture.elements.get(position.clip.id);
      paintClipFrame(element, position);
      if (position.clip.id !== gesture.id) continue;
      paintClipRoll(element, position.clip);
      renderMarker(position[gesture.edge]);
    }
  }

  function trackResize() {
    const gesture = resizeGesture;
    if (!gesture) return;
    scrollTrackAt(gesture.x);
    paintResizing(gesture);
    gesture.frame = requestAnimationFrame(trackResize);
  }

  function moveResize(event) {
    const gesture = resizeGesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture.x = event.clientX;
    if (!gesture.frame && gesture.x !== gesture.initialX) trackResize();
  }

  function endResize(event) {
    const gesture = resizeGesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const released = event.type === 'pointerup';
    if (released && gesture.frame) {
      gesture.x = event.clientX;
      paintResizing(gesture);
    }
    resizeGesture = undefined;
    cancelAnimationFrame(gesture.frame);
    viewport.removeAttribute('data-resizing');
    if (released && gesture.resized !== clips) {
      clips = gesture.resized;
      const {beats} = current();
      commit('片段已调整为 ' + beats + ' 拍');
    } else renderTimeline();
  }

  function resizeFromKeyboard(event) {
    const handle = event.target.closest('[data-edge]');
    if (!handle || !['ArrowLeft', 'ArrowRight'].includes(event.key) || resizeGesture) return;
    const id = Number(handle.closest('[data-clip]').dataset.clip);
    const position = positions.find(({clip}) => clip.id === id);
    if (!position) return;
    event.preventDefault();
    const edge = handle.dataset.edge;
    const beat = position[edge] + (event.key === 'ArrowLeft' ? -1 : 1);
    const resized = resizeClip(clips, id, edge, beat);
    if (resized === clips) return;
    selectedId = id;
    clips = resized;
    commit('片段已调整为 ' + current().beats + ' 拍');
  }

  let playback;
  let hover;

  function updateTransport() {
    $('play-sequence').disabled = !clips.length || playback?.type === 'sequence';
    $('stop').disabled = !playback;
  }

  function cancelPlayback() {
    stopHover();
    playback?.handle.stop();
  }

  function stopHover(surface) {
    if (hover && (!surface || hover.surface === surface)) {
      clearTimeout(hover.timer);
      hover = undefined;
    }
    if (playback?.hovered && (!surface || playback.surface === surface)) playback.handle.stop();
  }

  function beginHover(event, surface, play) {
    if (event.pointerType === 'touch' || drag || resizeGesture || playback?.type === 'sequence') return;
    // Hover audio needs a first click or key press in browsers with autoplay restrictions.
    let active = navigator.userActivation?.hasBeenActive;
    try { active ||= window.parent.navigator.userActivation?.hasBeenActive; } catch { /* Different origin. */ }
    if (active === false) return;
    stopHover();
    hover = {surface, timer: setTimeout(play, 125)};
  }

  function wireAudition(surface, play) {
    surface.setAttribute('aria-pressed', 'false');
    surface.addEventListener('pointerenter', (event) => beginHover(event, surface, () => play(true)));
    surface.addEventListener('pointerleave', () => stopHover(surface));
    surface.addEventListener('click', () => {
      if (playback?.surface === surface && !playback.hovered) return cancelPlayback();
      play(false);
    });
  }

  function playWithState(type, notes, options = {}, surface, hovered = false) {
    cancelPlayback();
    const handle = previewAudio.play(notes, {
      ...options,
      tpb: TICKS,
      onEnd: (reason) => {
        playback = null;
        if (surface?.classList.contains('word-card')) surface.removeAttribute('data-previewing');
        else surface?.setAttribute('aria-pressed', 'false');
        $('playhead').hidden = true;
        $('result-playhead').hidden = true;
        updateTransport();
        if (!hovered && reason === 'ended') status(type === 'sequence' ? '编曲播放完成' : '试听完成');
      },
      onError: status,
    });
    playback = {type, handle, surface, hovered};
    if (surface?.classList.contains('word-card')) surface.setAttribute('data-previewing', '');
    else surface?.setAttribute('aria-pressed', 'true');
    updateTransport();
    if (!hovered) status(type === 'sequence' ? '正在播放编曲' : type === 'word' ? '正在试听音词' : '正在试听音词事件实例');
  }

  function playWord(word, surface, hovered = false) {
    const clip = current();
    const notes = word?.notes ?? compileWord(clipWord(clip), clip, false).notes;
    playWithState('word', notes.map(([on, duration, pitch, velocity]) =>
      [on, on + duration, pitch, velocity]), {}, surface, hovered);
  }

  function showPlayhead(tick, end, follow) {
    const playhead = $('playhead');
    const x = tick / TICKS * beatSize;
    const beat = Math.floor(Math.min(tick, end - 1) / TICKS) + 1;
    playhead.hidden = false;
    playhead.style.left = x + 'px';
    playhead.toggleAttribute('data-at-start', x < 13);
    const label = playhead.firstElementChild;
    if (label.textContent !== String(beat)) label.textContent = beat;
    if (follow && (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth - 24)) {
      viewport.scrollLeft = Math.max(0, x - 24);
    }
  }

  function startPlayback(type, hovered = false, fromBeat = 0) {
    const sequence = type === 'sequence';
    const clip = current();
    const placements = sequence ? positions : [{clip, start: 0, end: clip.beats}];
    const end = (placements.at(-1)?.end ?? 0) * TICKS;
    const startTick = fromBeat * TICKS;
    if (startTick >= end) {
      if (end) {
        cancelPlayback();
        status('第 ' + (fromBeat + 1) + ' 拍已到编曲末尾');
      }
      return;
    }
    const pitches = placements.flatMap(({clip}) => [...new Set(getCompiled(clip).notes.map((note) => note[2]))]);
    let index = 0;
    const readWindow = (from, to, queue) => {
      while (index < placements.length) {
        const {clip, start, end} = placements[index];
        const offset = start * TICKS;
        if (offset >= to) break;
        if (end * TICKS > from) {
          const lower = Math.max(0, from - offset);
          const upper = Math.min(to, end * TICKS) - offset;
          visitNotes(getCompiled(clip), clip, lower, upper, ([on, duration, pitch, velocity]) =>
            queue([offset + on, offset + on + duration, pitch, velocity]),
          lower === 0 || from === startTick ? 'continue' : 'onset');
        }
        if (end * TICKS > to) break;
        index++;
      }
    };
    playWithState(type, [], {
      from: startTick, to: end, pitches, readWindow,
      onProgress: (tick) => {
        if (sequence) showPlayhead(tick, end, true);
        else {
          const cursor = $('result-playhead');
          const width = $('result-roll').clientWidth;
          cursor.hidden = false;
          cursor.style.left = (40 + (width - 43) * tick / end) + 'px';
          if (clip.start !== undefined) {
            const start = clip.start * TICKS;
            showPlayhead(start + tick, start + end, false);
          }
        }
      },
    }, sequence ? undefined : $('result-surface'), hovered);
  }

  function exportMidi() {
    const blob = writeMidi(clips, getCompiled, previewAudio.bpm);
    const url = URL.createObjectURL(blob);
    const link = makeElement('a');
    link.href = url;
    link.download = 'MusicWord-LEGO.mid';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已导出 ' + total + ' 拍 MIDI');
  }

  restore();
  for (const [key, choices] of Object.entries(harmonyOptions)) options($(key), choices);
  options($('preset'), presets.map(([label], index) => [index, label]));
  loadColors();
  renderLibrary();
  renderTimeline();
  renderEditor();
  renderPreset();

  for (const [id, [key, parse]] of Object.entries(fields)) {
    const input = $(id);
    if (numericChoices[id]) {
      wireNumericChoice(input, numericChoices[id]);
      continue;
    }
    input.addEventListener('input', () => {
      if (!input.value || !input.validity.valid) return;
      changeClip({[key]: parse(input.value)}, false);
    });
    input.addEventListener('change', () => renderEditor());
  }
  wireAudition($('word-surface'), (hovered) => playWord(undefined, $('word-surface'), hovered));
  wireAudition($('result-surface'), (hovered) => startPlayback('preview', hovered));
  $('search').addEventListener('input', () => { page = 0; renderLibrary(); });
  $('library-source').addEventListener('change', () => {
    stopHover();
    page = 0;
    $('library-song').value = '';
    updateSongFilter();
    renderLibrary();
    loadLibrary($('library-source').value);
  });
  $('library-song').addEventListener('change', () => { stopHover(); page = 0; renderLibrary(); });
  $('previous-page').addEventListener('click', () => { page--; renderLibrary(); });
  $('next-page').addEventListener('click', () => { page++; renderLibrary(); });
  $('word-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-word]');
    if (!button) return;
    const word = libraryCards.get(button);
    selectLibraryWord(word);
    playWord(word, button);
  });
  $('word-list').addEventListener('pointerover', (event) => {
    const word = event.target.closest('[data-word]');
    if (word && !word.contains(event.relatedTarget)) {
      beginHover(event, word, () => playWord(libraryCards.get(word), word, true));
    }
  });
  $('word-list').addEventListener('pointerout', (event) => {
    const word = event.target.closest('[data-word]');
    if (word && !word.contains(event.relatedTarget)) stopHover(word);
  });
  $('word-list').addEventListener('dragstart', (event) => {
    const word = event.target.closest('[data-word]');
    if (word) beginDrag(event, 'word', libraryCards.get(word));
  });
  $('word-drop').addEventListener('dragover', (event) => {
    if (drag?.kind !== 'word') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    $('word-drop').classList.add('drop-over');
  });
  $('word-drop').addEventListener('dragleave', (event) => {
    if (!$('word-drop').contains(event.relatedTarget)) $('word-drop').classList.remove('drop-over');
  });
  $('word-drop').addEventListener('drop', (event) => {
    if (drag?.kind !== 'word') return;
    event.preventDefault();
    selectLibraryWord(drag.id);
    endDrag();
  });
  $('result-surface').addEventListener('dragstart', (event) => beginDrag(event, 'result'));
  $('clips').addEventListener('dragstart', (event) => {
    const clip = event.target.closest('.clip-body')?.closest('[data-clip]');
    if (clip) beginDrag(event, 'move', Number(clip.dataset.clip));
  });
  document.addEventListener('dragend', endDrag);
  viewport.addEventListener('dragover', (event) => {
    if (!drag || drag.kind === 'word') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drag.kind === 'move' ? 'move' : 'copy';
    dragPoint = event.clientX;
    renderMarker(beatAt(dragPoint));
    if (!dragFrame) dragFrame = requestAnimationFrame(scrollWhileDragging);
  });
  viewport.addEventListener('dragleave', (event) => {
    if (viewport.contains(event.relatedTarget)) return;
    dragPoint = null;
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    renderMarker();
  });
  viewport.addEventListener('drop', (event) => {
    if (!drag || drag.kind === 'word') return;
    event.preventDefault();
    const beat = beatAt(event.clientX);
    if (drag.kind === 'result') addSegment(beat);
    else relocateClip(drag.id, beat);
    endDrag();
  });
  $('clips').addEventListener('click', (event) => {
    const clip = event.target.closest('.clip-body')?.closest('[data-clip]');
    if (!clip) return;
    selectedId = Number(clip.dataset.clip);
    renderTimeline();
    renderEditor();
    startPlayback('preview');
  });
  $('clips').addEventListener('pointerdown', beginResize);
  $('clips').addEventListener('pointermove', moveResize);
  $('clips').addEventListener('pointerup', endResize);
  $('clips').addEventListener('pointercancel', endResize);
  $('clips').addEventListener('lostpointercapture', endResize);
  $('clips').addEventListener('keydown', resizeFromKeyboard);
  $('ruler').addEventListener('click', (event) => {
    const beat = Math.max(0, Math.floor((event.clientX - timeline.getBoundingClientRect().left) / beatSize));
    pickBeat(beat);
    startPlayback('sequence', false, beat);
  });
  viewport.addEventListener('keydown', (event) => {
    if (event.target !== viewport) return;
    const beat = insertionBeat ?? 0;
    if (event.key === 'Enter') {
      event.preventDefault();
      startPlayback('sequence', false, beat);
      return;
    }
    const keys = {ArrowLeft: Math.max(0, beat - 1), ArrowRight: beat + 1, Home: 0, End: total};
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    pickBeat(keys[event.key], true);
  });
  viewport.addEventListener('scroll', () => {
    const edge = viewport.scrollLeft + viewport.clientWidth;
    if (viewport.scrollLeft > 0 && edge > rulerBeats * beatSize - beatSize) {
      extendRuler(Math.ceil(edge / beatSize));
    }
    renderRuler();
  }, {passive: true});
  $('close-clip').addEventListener('click', () => { selectedId = undefined; renderTimeline(); renderEditor(); });
  $('delete-clip').addEventListener('click', () => {
    clips = clips.filter((clip) => clip.id !== selectedId);
    selectedId = undefined;
    commit('已移除片段');
  });
  $('preset').addEventListener('change', renderPreset);
  $('preset-steps').addEventListener('input', (event) => editPresetStep(event.target));
  $('preset-steps').addEventListener('focusout', (event) => {
    const input = event.target;
    if (input.dataset.field === 'beats') {
      input.value = getPreset().steps[Number(input.closest('[data-step]').dataset.step)].beats;
    }
  });
  $('reset-preset').addEventListener('click', () => {
    editedPresets.delete(getPreset().label);
    renderPreset();
    save();
  });
  $('insert-preset').addEventListener('click', insertPreset);
  $('randomize').addEventListener('click', addRandomSection);
  $('export').addEventListener('click', exportMidi);
  $('play-sequence').addEventListener('click', () => startPlayback('sequence'));
  $('stop').addEventListener('click', () => { cancelPlayback(); status('已停止播放'); });
  document.addEventListener('musicword:themechange', () => {
    loadColors();
    renderLibrary();
    renderTimeline();
    paintEditor(current());
  });
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    if (event.data?.type === 'musicword:deactivate') cancelPlayback();
    if (event.data?.type === 'musicword:activate' && $('library-source').value === 'saved') loadLibrary('saved');
  });
  const resize = new ResizeObserver(() => {
    paintEditor(current());
    renderRuler();
    if (libraryPageSize() !== pageSize) renderLibrary();
    else paintLibrary();
  });
  resize.observe(viewport);
  resize.observe($('word-list'));
  window.MusicWordParameters = {
    validate(values) {
      if (!values || !validClip(values.draft) || !Array.isArray(values.clips) || !values.clips.every(validClip) ||
          !values.editedPresets || !Number.isInteger(values.preset) || !presets[values.preset]) {
        throw new Error('LEGO 参数方案无效。');
      }
      for (const [label, steps] of Object.entries(values.editedPresets)) {
        const defaults = presets.find(([name]) => name === label)?.[1];
        if (!defaults || !Array.isArray(steps) || defaults.length !== steps.length || !steps.every(validChordStep)) {
          throw new Error('LEGO 和弦进行参数无效。');
        }
      }
    },
    snapshot() {
      const invalid = [...document.querySelectorAll('.ingredients input, #preset-steps input')].find((field) => !field.checkValidity());
      if (invalid) throw new Error('请先填写有效的 LEGO 参数。');
      const values = structuredClone({draft, clips, editedPresets: Object.fromEntries(editedPresets), preset: Number($('preset').value)});
      this.validate(values);
      return values;
    },
    apply(values) {
      this.validate(values);
      cancelPlayback();
      stopHover();
      draft = structuredClone(values.draft);
      clips = structuredClone(values.clips).map((clip) => ({...clip, id: nextId++}));
      selectedId = undefined;
      insertionBeat = null;
      editedPresets.clear();
      for (const [label, steps] of Object.entries(values.editedPresets)) editedPresets.set(label, structuredClone(steps));
      $('preset').value = values.preset;
      renderTimeline();
      renderEditor();
      renderPreset();
      save();
    },
  };
})();
