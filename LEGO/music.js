(() => {
  const TICKS = 240;
  const ROOTS = {C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11};
  const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const QUALITIES = {
    maj: ['大三', [0, 4, 7]], min: ['小三', [0, 3, 7]], dim: ['减三', [0, 3, 6]], aug: ['增三', [0, 4, 8]],
    dom7: ['属七', [0, 4, 7, 10]], maj7: ['大七', [0, 4, 7, 11]], min7: ['小七', [0, 3, 7, 10]],
    minmaj7: ['小大七', [0, 3, 7, 11]], dim7: ['减七', [0, 3, 6, 9]], hdim7: ['半减七', [0, 3, 6, 10]],
    sus2: ['挂二', [0, 2, 7]], sus4: ['挂四', [0, 5, 7]], 6: ['大六', [0, 4, 7, 9]],
    min6: ['小六', [0, 3, 7, 9]], 9: ['属九', [0, 4, 7, 10, 14]], maj9: ['大九', [0, 4, 7, 11, 14]],
    min9: ['小九', [0, 3, 7, 10, 14]],
  };
  const QUALITY_ORDER = ['maj', 'min', 'dim', 'aug', 'dom7', 'maj7', 'min7', 'minmaj7', 'dim7', 'hdim7', 'sus2', 'sus4', '6', 'min6', '9', 'maj9', 'min9'];
  const SOURCE_CHORD = QUALITIES.maj7[1];
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const displayRoot = (root) => root.replace('#', '♯').replace('b', '♭');
  const pitchName = (pitch) => PITCH_NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1);
  const chordName = ({root, quality}) => displayRoot(root) + ({maj: '', min: 'm', dom7: '7', min7: 'm7', min9: 'm9', min6: 'm6'}[quality] ?? quality);
  const chordNotes = ({root, quality, octave}) =>
    QUALITIES[quality][1].map((interval) => 12 * (octave + 1) + ROOTS[root] + interval);

  function chordToneNames(settings) {
    const {root, quality, octave} = settings;
    const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const rootIndex = letters.indexOf(root[0]);
    const third = {sus2: 1, sus4: 3}[quality] ?? 2;
    const fourthTone = ['6', 'min6'].includes(quality) ? 5 : 6;
    const degrees = [0, third, 4, fourthTone, 8];
    return chordNotes(settings).map((pitch, index) => {
      const position = rootIndex + degrees[index];
      const letter = letters[position % letters.length];
      const register = octave + Math.floor(position / letters.length);
      const accidentals = pitch - (12 * (register + 1) + ROOTS[letter]);
      return letter + (accidentals < 0 ? '♭' : '♯').repeat(Math.abs(accidentals)) + register;
    });
  }

  function mapPitch(pitch, chord) {
    const pitchClass = ((pitch % 12) + 12) % 12;
    const position = SOURCE_CHORD.indexOf(pitchClass);
    // The original remaps chord-tone positions and sends nonchord tones to
    // the next scale degree by upward pitch-class distance.
    const distances = MAJOR_SCALE.map((degree) => (degree - pitchClass + 12) % 12);
    const target = position >= 0
      ? chord[Math.min(position, chord.length - 1)]
      : chord[0] + MAJOR_SCALE[distances.indexOf(Math.min(...distances))];
    let result = target + (Math.floor(pitch / 12) - 5) * 12;
    while (result < 0) result += 12;
    while (result > 127) result -= 12;
    return result;
  }

  function wordLength(notes) {
    const end = notes.reduce((max, [start, duration]) => Math.max(max, start + duration), 0);
    return Math.max(1, Math.ceil(end / TICKS));
  }

  function compileWord(word, settings, harmonize = true) {
    let low = 127, high = 0, first = Infinity, last = 0;
    for (const [start, , pitch] of word.notes) {
      low = Math.min(low, pitch);
      high = Math.max(high, pitch);
      first = Math.min(first, start);
      last = Math.max(last, start);
    }
    const chord = chordNotes(settings);
    const notes = word.notes.map(([onset, duration, pitch, velocity]) => {
      if (settings.flip === 'vertical') pitch = low + high - pitch;
      if (settings.flip === 'diagonal') {
        // Exchange the normalized onset and pitch coordinates. The note's
        // duration still belongs to the time axis and is controlled by D.
        const timePosition = last === first ? 0.5 : (onset - first) / (last - first);
        const pitchPosition = high === low ? 0.5 : (pitch - low) / (high - low);
        onset = first + pitchPosition * (last - first);
        pitch = Math.round(low + timePosition * (high - low));
      }
      return [Math.round(onset / settings.density), Math.max(1, Math.round(duration * settings.decay)), pitch, velocity];
    });
    if (settings.flip === 'horizontal') {
      const edge = notes.reduce((max, [start, duration]) => Math.max(max, start + duration), 0);
      for (const note of notes) note[0] = edge - note[0] - note[1];
    }
    if (harmonize) for (const note of notes) note[2] = mapPitch(note[2], chord);
    notes.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    return {notes, period: wordLength(notes) * TICKS};
  }

  // Visit only cycles that intersect the requested window. A split clip keeps
  // its phase, so inserting mid-word preserves the remainder of the phrase.
  function visitNotes(compiled, clip, from, to, visitor, mode = 'crop') {
    const phase = clip.offset;
    const length = clip.beats * TICKS;
    const stop = Math.min(length, to);
    if (clip.imported) {
      for (const [onset, duration, pitch, velocity] of compiled.notes) {
        const start = onset - phase;
        if (start >= stop) break;
        const end = Math.min(start + duration, length);
        if (end <= from || (mode === 'onset' && start < from)) continue;
        const croppedStart = Math.max(start, from);
        visitor([croppedStart, (mode === 'crop' ? Math.min(end, stop) : end) - croppedStart, pitch, velocity]);
      }
      return;
    }
    const firstCycle = Math.floor((phase + from) / compiled.period);
    for (let cycle = firstCycle; cycle * compiled.period < phase + stop; cycle++) {
      const base = cycle * compiled.period - phase;
      for (const [onset, duration, pitch, velocity] of compiled.notes) {
        const start = base + onset;
        if (start >= stop) break;
        const end = Math.min(start + duration, length);
        if (end <= from || (mode === 'onset' && start < from)) continue;
        const croppedStart = Math.max(start, from);
        const croppedEnd = mode === 'crop' ? Math.min(end, stop) : end;
        visitor([croppedStart, croppedEnd - croppedStart, pitch, velocity]);
      }
    }
  }

  function placeClips(clips) {
    let beat = 0;
    return clips.map((clip) => {
      const start = clip.start ?? beat;
      const end = start + clip.beats;
      beat = Math.max(beat, end);
      return {clip, start, end};
    }).sort((a, b) => a.start - b.start);
  }

  function insertAtBeat(clips, beat, incoming, nextId) {
    const before = [];
    const after = [];
    let cursor = beat + incoming.beats;
    for (const {clip, start, end} of placeClips(clips)) {
      if (end <= beat) {
        before.push(clip);
        continue;
      }
      const split = start < beat ? beat - start : 0;
      if (split) before.push({...clip, start, beats: split});
      const nextStart = Math.max(cursor, start);
      const beats = clip.beats - split;
      after.push({...clip, start: nextStart, beats,
        ...(split ? {id: nextId(), offset: clip.offset + split * TICKS} : {})});
      cursor = nextStart + beats;
    }
    return [...before, {...incoming, start: beat}, ...after];
  }

  function moveToBeat(clips, id, beat, nextId) {
    const position = placeClips(clips).find(({clip}) => clip.id === id);
    if (!position || beat === position.start) return clips;
    return insertAtBeat(clips.filter((clip) => clip.id !== id), beat, position.clip, nextId);
  }

  function resizeClip(clips, id, edge, beat) {
    const positions = placeClips(clips);
    const index = positions.findIndex(({clip}) => clip.id === id);
    if (index < 0) return clips;
    const {clip, start, end} = positions[index];
    const maxBeats = clip.imported ? Infinity : Math.max(16, clip.beats);
    const resized = positions.map(({clip}) => clip);
    if (edge === 'start') {
      const occupied = positions.slice(0, index).reduce((sum, position) => sum + position.clip.beats, 0);
      const next = Math.max(occupied, end - maxBeats, Math.min(end - 1, beat));
      if (next === start) return clips;
      resized[index] = {...clip, start: next, beats: end - next, offset: clip.offset + (next - start) * TICKS};
      let cursor = next;
      for (let i = index - 1; i >= 0 && positions[i].end > cursor; i--) {
        cursor -= positions[i].clip.beats;
        resized[i] = {...positions[i].clip, start: cursor};
      }
    } else {
      const next = Math.max(start + 1, Math.min(start + maxBeats, beat));
      if (next === end) return clips;
      resized[index] = {...clip, start, beats: next - start};
      let cursor = next;
      for (let i = index + 1; i < positions.length && positions[i].start < cursor; i++) {
        resized[i] = {...positions[i].clip, start: cursor};
        cursor += positions[i].clip.beats;
      }
    }
    return resized;
  }

  function variableBytes(value) {
    const bytes = [value % 128];
    for (let next = Math.floor(value / 128); next > 0; next = Math.floor(next / 128)) {
      bytes.unshift(0x80 + next % 128);
    }
    return bytes;
  }

  function writeMidi(clips, getCompiled, bpm) {
    const tempo = Math.round(60_000_000 / bpm);
    const track = [0, 0xff, 0x51, 3, tempo >> 16, (tempo >> 8) & 255, tempo & 255];
    let last = 0;
    let total = 0;
    function append(tick, ...bytes) {
      // SMF delta times are limited to four bytes. Empty text events bridge
      // arbitrarily long silence while preserving the clip grid.
      while (tick - last > 0x0fffffff) {
        track.push(...variableBytes(0x0fffffff), 0xff, 0x01, 0);
        last += 0x0fffffff;
      }
      track.push(...variableBytes(tick - last), ...bytes);
      last = tick;
    }
    for (const {clip, start, end} of placeClips(clips)) {
      total = end * TICKS;
      const events = [];
      const notesByPitch = new Map();
      visitNotes(getCompiled(clip), clip, 0, clip.beats * TICKS, ([onset, duration, pitch, velocity]) => {
        const previous = notesByPitch.get(pitch);
        const tick = start * TICKS + onset;
        if (previous && previous[1] > tick) {
          previous[1] = Math.max(previous[1], tick + duration);
          return;
        }
        const off = [pitch, tick + duration, 0];
        events.push([pitch, tick, velocity], off);
        notesByPitch.set(pitch, off);
      });
      events.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
      for (const [pitch, tick, velocity] of events) append(tick, velocity ? 0x90 : 0x80, pitch, velocity);
    }
    append(total, 0xff, 0x2f, 0);
    const header = new Uint8Array([
      77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, TICKS >> 8, TICKS & 255,
      77, 84, 114, 107, 0, 0, 0, 0,
    ]);
    new DataView(header.buffer).setUint32(18, track.length);
    return new Blob([header, Uint8Array.from(track)], {type: 'audio/midi'});
  }

  globalThis.LegoMusic = {
    TICKS, ROOTS, QUALITIES, QUALITY_ORDER, displayRoot, pitchName, chordName, chordNotes, chordToneNames,
    wordLength, compileWord, visitNotes, placeClips, insertAtBeat, moveToBeat, resizeClip, writeMidi,
  };
})();
