(() => {
  const PPQ = 10080;
  const maxFile = 12 * 1024 * 1024;
  const maxXml = 24 * 1024 * 1024;
  const steps = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const beatUnits = { whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25, '32nd': .125 };
  const children = (node, name) => [...(node?.children ?? [])].filter((child) => child.localName === name);
  const first = (node, name) => children(node, name)[0];
  const value = (node, name) => first(node, name)?.textContent.trim();
  const number = (node, name, fallback = 0) => Number(value(node, name) ?? fallback);
  const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

  function parse(bytes) {
    let encoding = 'utf-8';
    if ((bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 60 && bytes[1] === 0)) encoding = 'utf-16le';
    else if ((bytes[0] === 254 && bytes[1] === 255) || (bytes[0] === 0 && bytes[1] === 60)) encoding = 'utf-16be';
    else encoding = new TextDecoder().decode(bytes.subarray(0, 160)).match(/<\?xml[^>]*?encoding=['"]([^'"]+)/i)?.[1] ?? encoding;
    const text = new TextDecoder(encoding).decode(bytes);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('MusicXML 格式有误，无法读取乐谱。');
    return doc.documentElement;
  }

  async function compressedScore(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset) => view.getUint16(offset, true);
    const u32 = (offset) => view.getUint32(offset, true);
    const invalid = () => new Error('无法读取 .mxl 压缩乐谱。');
    let end = bytes.length - 22;
    const firstPossible = Math.max(0, end - 65535);
    while (end >= firstPossible && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
    if (end < firstPossible || u16(end + 4) || u16(end + 6)) throw invalid();
    const entries = new Map();
    let offset = u32(end + 16);
    const decoder = new TextDecoder();
    for (let i = 0; i < u16(end + 10); i++) {
      if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalid();
      const nameEnd = offset + 46 + u16(offset + 28);
      if (nameEnd > end) throw invalid();
      entries.set(decoder.decode(bytes.subarray(offset + 46, nameEnd)), {
        flags: u16(offset + 8), method: u16(offset + 10), size: u32(offset + 24),
        packed: u32(offset + 20), local: u32(offset + 42),
      });
      offset = nameEnd + u16(offset + 30) + u16(offset + 32);
    }
    async function extract(name) {
      const entry = entries.get(name);
      if (!entry || entry.flags & 1 || entry.size > maxXml) throw invalid();
      const { local } = entry;
      if (local + 30 > end || u32(local) !== 0x04034b50) throw invalid();
      const begin = local + 30 + u16(local + 26) + u16(local + 28);
      if (begin + entry.packed > end) throw invalid();
      const packed = bytes.subarray(begin, begin + entry.packed);
      if (entry.method === 0 && packed.length === entry.size) return packed;
      if (entry.method !== 8) throw invalid();
      const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const xml = new Uint8Array(entry.size);
      let count = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (count + value.length > xml.length) throw invalid();
          xml.set(value, count);
          count += value.length;
        }
      } finally {
        await reader.cancel();
      }
      if (count !== xml.length) throw invalid();
      return xml;
    }
    const container = parse(await extract('META-INF/container.xml'));
    const files = children(first(container, 'rootfiles'), 'rootfile');
    const file = files.find((entry) => /\.musicxml$/i.test(entry.getAttribute('full-path'))) ?? files[0];
    return extract(file?.getAttribute('full-path'));
  }

  function directionTempo(direction) {
    const sound = direction.localName === 'sound' ? direction : first(direction, 'sound');
    const direct = Number(sound?.getAttribute('tempo'));
    if (direct > 0) return direct;
    const metro = children(direction, 'direction-type').map((kind) => first(kind, 'metronome')).find(Boolean);
    const rate = number(metro, 'per-minute');
    const unit = beatUnits[value(metro, 'beat-unit')];
    const dots = children(metro, 'beat-unit-dot').length;
    return rate * unit * (2 - .5 ** dots);
  }

  function midiTracks(part, measures, index, tempos, signatures) {
    const channels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    const defaultChannel = channels[index % channels.length];
    const instruments = new Map(children(part, 'midi-instrument').map((instrument) => {
      const percussion = number(instrument, 'midi-unpitched');
      const channel = number(instrument, 'midi-channel') - 1;
      return [instrument.getAttribute('id'), {
        channel: percussion ? 9 : channel >= 0 && channel < 16 ? channel : defaultChannel,
        program: clamp(number(instrument, 'midi-program', 1) - 1, 0, 127), percussion,
      }];
    }));
    const fallback = instruments.values().next().value ?? { channel: defaultChannel, program: 0, percussion: 0 };
    const name = value(part, 'part-name')?.replace(/[^\x20-\x7e]/g, '').trim() || `Part ${index + 1}`;
    const tracks = new Map();
    const ties = new Map();
    const transpositions = new Map();
    let divisions = 1, begin = 0, nominalLength = 4;
    for (const measure of measures) {
      let cursor = 0, length = 0, chordStart = 0;
      for (const item of measure?.children ?? []) {
        const type = item.localName;
        if (type === 'attributes') {
          divisions = number(item, 'divisions', divisions);
          if (!(divisions > 0)) throw new Error('MusicXML 的节拍分辨率无效。');
          for (const transpose of children(item, 'transpose')) transpositions.set(transpose.getAttribute('number') ?? '',
            number(transpose, 'chromatic') + 12 * number(transpose, 'octave-change'));
          const time = first(item, 'time');
          if (time) {
            const beats = (value(time, 'beats') ?? '').split('+').reduce((sum, part) => sum + Number(part), 0);
            const unit = number(time, 'beat-type');
            if (beats > 0 && unit > 0) {
              nominalLength = beats * 4 / unit;
              const tick = Math.round(begin * PPQ);
              if (!signatures.has(tick) && beats < 256 && Number.isInteger(Math.log2(unit))) signatures.set(tick, [beats, unit]);
            }
          }
          continue;
        }
        if (type === 'direction' || type === 'sound') {
          const bpm = directionTempo(item);
          if (Number.isFinite(bpm) && bpm > 0) {
            const tick = Math.max(0, Math.round((begin + cursor + number(item, 'offset') / divisions) * PPQ));
            if (!tempos.has(tick)) tempos.set(tick, clamp(bpm, 4, 999));
          }
          continue;
        }
        if (!['note', 'backup', 'forward'].includes(type)) continue;
        const duration = number(item, 'duration') / divisions;
        if (!Number.isFinite(duration) || duration < 0) throw new Error('MusicXML 的音符时值无效。');
        if (type !== 'note') {
          cursor = Math.max(0, cursor + (type === 'backup' ? -duration : duration));
          length = Math.max(length, cursor);
          continue;
        }
        if (first(item, 'grace') || !duration) continue;
        if (!first(item, 'chord')) {
          chordStart = cursor;
          cursor += duration;
        }
        length = Math.max(length, cursor, chordStart + duration);
        if (first(item, 'rest')) continue;
        const instrument = instruments.get(first(item, 'instrument')?.getAttribute('id')) ?? fallback;
        const pitch = first(item, 'pitch');
        const staff = value(item, 'staff');
        const transpose = transpositions.get(staff) ?? transpositions.get('') ?? 0;
        const unpitched = first(item, 'unpitched');
        const midiPitch = pitch ? Math.round((number(pitch, 'octave') + 1) * 12 + steps[value(pitch, 'step')]
          + number(pitch, 'alter') + transpose)
          : unpitched && instrument.percussion ? instrument.percussion - 1 : NaN;
        if (!Number.isInteger(midiPitch) || midiPitch < 0 || midiPitch > 127) continue;
        if (!tracks.has(instrument)) tracks.set(instrument, { name, ...instrument, notes: [] });
        const track = tracks.get(instrument);
        const on = Math.round((begin + chordStart) * PPQ);
        const off = Math.max(on + 1, Math.round((begin + chordStart + duration) * PPQ));
        if (off > 0x0fffffff) throw new Error('MusicXML 超出可转换的乐谱长度。');
        const tieKey = [instrument.channel, instrument.program, staff, value(item, 'voice'), midiPitch].join(':');
        const marks = children(item, 'tie');
        const starts = marks.some((mark) => mark.getAttribute('type') === 'start');
        const stops = marks.some((mark) => mark.getAttribute('type') === 'stop');
        let note = stops ? ties.get(tieKey) : null;
        if (note) note.durationTicks = off - note.ticks;
        else {
          const dynamics = Number(item.getAttribute('dynamics') ?? 100);
          const velocity = Number.isFinite(dynamics) ? clamp(Math.round(dynamics * .9), 1, 127) : 90;
          note = { midi: midiPitch, ticks: on, durationTicks: off - on, velocity: Math.min(1, (velocity + .01) / 127) };
          track.notes.push(note);
        }
        if (starts) ties.set(tieKey, note);
        else if (stops) ties.delete(tieKey);
      }
      begin += length || nominalLength;
    }
    return tracks.values();
  }

  async function convert(file) {
    if (!file.size || file.size > maxFile) throw new Error('请选择 12 MB 以内的 MusicXML 文件。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const score = parse(/\.mxl$/i.test(file.name) ? await compressedScore(bytes) : bytes);
    const timewise = score.localName === 'score-timewise';
    if (!timewise && score.localName !== 'score-partwise') throw new Error('请选择包含 MusicXML 乐谱的文件。');
    const sections = timewise ? children(score, 'measure').map((measure) =>
      new Map(children(measure, 'part').map((part) => [part.getAttribute('id'), part])))
      : new Map(children(score, 'part').map((part) => [part.getAttribute('id'), children(part, 'measure')]));
    const parts = children(first(score, 'part-list'), 'score-part');
    const midi = new window.Midi();
    const tempos = new Map(), signatures = new Map();
    for (const [index, part] of parts.entries()) {
      const id = part.getAttribute('id');
      const measures = timewise ? sections.map((measure) => measure.get(id)) : sections.get(id) ?? [];
      for (const result of midiTracks(part, measures, index, tempos, signatures)) {
        const track = midi.addTrack();
        track.name = result.name;
        track.channel = result.channel;
        track.instrument.number = result.program;
        for (const note of result.notes) track.addNote(note);
      }
    }
    if (!midi.tracks.length) throw new Error('MusicXML 中没有可转换的音符。');
    if (!tempos.has(0)) tempos.set(0, 120);
    midi.header.fromJSON({
      ...midi.header.toJSON(), ppq: PPQ,
      tempos: [...tempos].map(([ticks, bpm]) => ({ ticks, bpm })),
      timeSignatures: [...signatures].map(([ticks, timeSignature]) => ({ ticks, timeSignature })),
    });
    return new File([midi.toArray()], file.name.replace(/\.[^.]+$/, '.mid'), { type: 'audio/midi' });
  }

  window.MusicWordScore = { convert };
})();
