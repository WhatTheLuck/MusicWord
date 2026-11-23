(() => {
  let upstream;
  try {
    if (window.parent !== window) upstream = window.parent.MusicWordPreview;
  } catch { /* A separately hosted page uses its own player. */ }

  const assetRoot = document.currentScript.src
    ? new URL('.', document.currentScript.src) : null;
  const instruments = [
    ['acoustic_grand_piano', '三角钢琴', .15],
    ['electric_piano_1', '电钢琴', .16],
    ['acoustic_guitar_nylon', '尼龙弦吉他', .12],
    ['vibraphone', '颤音琴', .24],
    ['string_ensemble_1', '弦乐合奏', .25],
    ['cello', '大提琴', .19],
    ['flute', '长笛', .12],
    ['clarinet', '单簧管', .12],
  ];
  const accept = '.mid,.midi,.xml,.musicxml,.mxl';
  const storageKey = 'musicword.preview.v1';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const settings = { instrument: instruments[0][0], bpm: 120, volume: 70 };
  let savedBpm = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (instruments.some(([id]) => id === saved?.instrument)) settings.instrument = saved.instrument;
    if (Number.isFinite(saved?.bpm)) {
      settings.bpm = clamp(saved.bpm, 30, 300);
      savedBpm = true;
    }
    if (Number.isFinite(saved?.volume)) settings.volume = clamp(saved.volume, 0, 100);
  } catch { /* Playback also works without storage. */ }

  const scripts = new Map();
  const rawSamples = new Map();
  const buffers = new Map();
  let audio, master, current, toolbar;
  let playbackStatus = '', preloadStatus = '';

  function loadScript(path, priority = 'auto') {
    if (!scripts.has(path)) {
      const task = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const embedded = document.getElementById('musicword-preview-assets');
        if (embedded) {
          if (!loadScript.assets) loadScript.assets = JSON.parse(embedded.textContent);
          const source = loadScript.assets[path];
          if (!source) return reject(new Error('离线文件缺少试听资源。'));
          script.textContent = source;
          document.head.append(script);
          script.remove();
          resolve();
          return;
        }
        script.fetchPriority = priority;
        script.src = new URL(path, assetRoot);
        script.onload = () => { script.remove(); resolve(); };
        script.onerror = () => { script.remove(); reject(new Error('无法加载本地试听资源，请重试。')); };
        document.head.append(script);
      });
      scripts.set(path, task);
      task.catch(() => scripts.delete(path));
    }
    return scripts.get(path);
  }

  async function prepareFile(file) {
    if (/\.midi?$/i.test(file.name)) return { file };
    if (!/\.(?:musicxml|xml|mxl)$/i.test(file.name)) throw new Error('请选择 MIDI 或 MusicXML 文件。');
    await Promise.all([loadScript('midi.js'), loadScript('score.js')]);
    const converted = await window.MusicWordScore.convert(file);
    return { file: converted, converted: true };
  }

  async function readMidi(file) {
    await loadScript('midi.js');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'MThd') throw new Error('请选择有效的 MIDI 文件。');
    const midi = new window.Midi(bytes);
    if (!(midi.header.ppq > 0)) throw new Error('MIDI 必须使用每拍刻度。');
    if (!midi.tracks.some((track) => track.notes.length)) throw new Error('MIDI 中没有可播放的音符。');
    return midi;
  }

  function attachImport(input, onFile, onError) {
    input.accept = accept;
    const download = document.createElement('a');
    download.className = 'mw-converted-midi';
    download.textContent = '下载转换后的 MIDI';
    download.hidden = true;
    (input.closest('label') || input).after(download);
    let request = 0, url;
    const clear = () => {
      download.hidden = true;
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    const handler = async () => {
      const selected = input.files[0];
      input.value = '';
      if (!selected) return;
      const token = ++request;
      clear();
      try {
        const { file, converted } = await prepareFile(selected);
        if (token !== request) return;
        await onFile(file);
        if (token !== request || !converted) return;
        url = URL.createObjectURL(file);
        download.href = url;
        download.download = file.name;
        download.hidden = false;
      } catch (error) {
        if (token === request) onError(error.message || '无法读取乐谱。');
      }
    };
    input.addEventListener('change', handler);
    window.addEventListener('pagehide', clear);
    return () => {
      request++;
      clear();
      input.removeEventListener('change', handler);
      window.removeEventListener('pagehide', clear);
      download.remove();
    };
  }

  function renderStatus() {
    if (!toolbar) return;
    toolbar.querySelector('output').textContent = playbackStatus || preloadStatus;
    toolbar.querySelector('button').disabled = !current;
  }

  function updateStatus(message = '') {
    playbackStatus = message;
    renderStatus();
  }

  function finish(state, reason) {
    if (current !== state) return;
    current = null;
    clearInterval(state.timer);
    cancelAnimationFrame(state.frame);
    if (reason !== 'ended') {
      for (const source of state.voices) {
        source.disconnect();
        source.stop();
      }
    }
    state.onEnd?.(reason);
    updateStatus(state.error ?? '');
  }

  function setSetting(key, value) {
    if (key === 'bpm') savedBpm = true;
    if (settings[key] === value) return;
    settings[key] = value;
    if (key === 'volume' && master) {
      master.gain.setTargetAtTime((value / 100) ** 2, audio.currentTime, .025);
    } else if (key !== 'volume' && current) {
      finish(current, 'stopped');
    } else if (key === 'instrument') {
      updateStatus();
    }
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Session only. */ }
  }

  async function loadBank(instrument, priority) {
    if (rawSamples.has(instrument)) return rawSamples.get(instrument);
    const path = 'samples/' + instrument + '.js';
    const name = instruments.find(([id]) => id === instrument)[1];
    try {
      await loadScript(path, priority);
      const bank = rawSamples.get(instrument);
      if (bank) return bank;
    } catch { /* The next audition can retry the failed request. */ }
    scripts.delete(path);
    throw new Error(`无法读取「${name}」的本地音色文件，请刷新后重试。`);
  }

  function preloadBanks() {
    const ordered = [settings.instrument, ...instruments.map(([id]) => id).filter((id) => id !== settings.instrument)];
    let loaded = 0, remaining = ordered.length;
    const show = () => {
      preloadStatus = remaining ? `预载音色 ${loaded}/${ordered.length}`
        : loaded < ordered.length ? `已预载 ${loaded}/${ordered.length} 款，缺失音色会在试听时重试` : '';
      renderStatus();
    };
    show();
    for (const [index, instrument] of ordered.entries()) {
      loadBank(instrument, index === 0 ? 'high' : 'low')
        .then(() => { loaded++; }, () => {})
        .finally(() => { remaining--; show(); });
    }
  }

  async function sampleFor(instrument, pitch) {
    const root = clamp(Math.round(pitch / 4) * 4, 24, 96);
    const key = instrument + ':' + root;
    if (!buffers.has(key)) {
      const pending = (async () => {
        const bank = await loadBank(instrument);
        const base64 = bank[root];
        if (!base64) throw new Error('找不到对应音高的采样。');
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        try {
          return { buffer: await audio.decodeAudioData(bytes.buffer), root };
        } catch (error) {
          const name = instruments.find(([id]) => id === instrument)[1];
          throw new Error(`浏览器无法解码「${name}」的采样。`, { cause: error });
        }
      })();
      buffers.set(key, pending);
      pending.catch(() => buffers.delete(key));
    }
    return buffers.get(key);
  }

  function sound(state, samples, [on, off, pitch, velocity], at) {
    const { buffer, root } = samples.get(pitch);
    const duration = Math.max(.024, (off - on) * state.secondsPerTick);
    const release = state.release;
    const stop = at + duration + release;
    const source = audio.createBufferSource();
    const level = audio.createGain();
    const rate = 2 ** ((pitch - root) / 12);
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const sustain = ['string_ensemble_1', 'cello', 'flute', 'clarinet'].includes(state.instrument);
    if (sustain && buffer.duration > 1.6 && duration * rate > buffer.duration - .6) {
      source.loop = true;
      source.loopStart = .48;
      source.loopEnd = Math.min(1.3, buffer.duration - .5);
    }
    const peak = .52 * (clamp(velocity ?? 90, 1, 127) / 127) ** 1.3;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(peak, at + .008);
    level.gain.setValueAtTime(peak, at + duration);
    level.gain.linearRampToValueAtTime(0, stop);
    source.connect(level).connect(master);
    state.voices.add(source);
    source.onended = () => {
      state.voices.delete(source);
      source.disconnect();
      level.disconnect();
    };
    source.start(at);
    source.stop(stop + .01);
  }

  function play(notes, options = {}) {
    if (current) finish(current, 'stopped');
    const [instrument, , release] = instruments.find(([id]) => id === settings.instrument);
    const state = { instrument, release, onEnd: options.onEnd, voices: new Set() };
    current = state;
    const handle = { stop: () => finish(state, 'stopped') };
    const from = options.from ?? 0;
    const trackEnd = options.to ?? notes.reduce((end, note) => Math.max(end, note[1]), from);
    const events = notes.filter(([on, off, pitch]) => on < trackEnd && off > from
      && Number.isInteger(pitch) && pitch >= 0 && pitch <= 127)
      .map(([on, off, pitch, velocity]) => [Math.max(on, from), Math.min(off, trackEnd), pitch, velocity])
      .sort((a, b) => a[0] - b[0]);
    state.secondsPerTick = 60 / (settings.bpm * (options.tpb || 24));

    if (!events.length && !options.readWindow) {
      queueMicrotask(() => finish(state, 'empty'));
      return handle;
    }
    updateStatus('正在加载音色…');
    async function start() {
      if (!audio) {
        const AudioEngine = window.AudioContext || window.webkitAudioContext;
        if (!AudioEngine) throw new Error('当前浏览器无法使用网页音频。');
        audio = new AudioEngine();
        master = audio.createGain();
        master.gain.value = (settings.volume / 100) ** 2;
        const compressor = audio.createDynamicsCompressor();
        master.connect(compressor).connect(audio.destination);
      }
      try { await audio.resume(); }
      catch (error) { throw new Error('浏览器无法启动音频，请检查网页的声音权限。', { cause: error }); }
      if (current !== state) return;
      const pitches = [...new Set(options.pitches ?? events.map((note) => note[2]))];
      const samples = new Map(await Promise.all(pitches.map(async (pitch) => [pitch, await sampleFor(instrument, pitch)])));
      if (current !== state) return;
      const startAt = audio.currentTime + .04;
      let next = 0, scheduled = from;
      const schedule = () => {
        const now = audio.currentTime;
        const horizon = now + .17;
        const queueNote = (note) => {
          const at = startAt + (note[0] - from) * state.secondsPerTick;
          if (now - at < .25) sound(state, samples, note, Math.max(now, at));
        };
        if (options.readWindow) {
          const upper = Math.min(trackEnd, from + Math.ceil((horizon - startAt) / state.secondsPerTick));
          if (upper > scheduled) {
            const lower = Math.max(scheduled, from + Math.floor((now - .25 - startAt) / state.secondsPerTick));
            options.readWindow(lower, upper, queueNote);
            scheduled = upper;
          }
        } else {
          while (next < events.length && startAt + (events[next][0] - from) * state.secondsPerTick <= horizon) {
            queueNote(events[next++]);
          }
        }
        if (now >= startAt + (trackEnd - from) * state.secondsPerTick + release + .02) finish(state, 'ended');
      };
      const progress = () => {
        if (current !== state) return;
        options.onProgress(Math.min(trackEnd, from + Math.max(0, audio.currentTime - startAt) / state.secondsPerTick));
        state.frame = requestAnimationFrame(progress);
      };
      updateStatus('试听中');
      state.timer = setInterval(schedule, 25);
      schedule();
      if (options.onProgress) progress();
    }
    start().catch((error) => {
      if (current !== state) return;
      state.error = error.message;
      finish(state, 'error');
      options.onError?.(error.message);
    });
    return handle;
  }

  function bindRoll(element, getClip, label, { pointerOnly = false } = {}) {
    let session;
    element.classList.add('mw-playable');
    if (!pointerOnly) {
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', label);
      element.setAttribute('aria-pressed', 'false');
      element.tabIndex = 0;
    }
    element.title = label;
    function activate(event) {
      if (!pointerOnly) event.stopPropagation();
      if (session) return session.stop();
      const clip = getClip(event);
      if (!clip?.notes.length) return;
      element.setAttribute('aria-pressed', 'true');
      session = api.play(clip.notes, {
        ...clip,
        onEnd: (reason) => {
          session = null;
          element.setAttribute('aria-pressed', 'false');
          clip.onEnd?.(reason);
        },
      });
    }
    element.addEventListener('click', activate);
    if (!pointerOnly) element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate(event);
    });
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = `
      .mw-audio-bar{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:5px 12px;border-block-start:1px solid var(--mw-line,#8884);background:var(--mw-surface,Canvas);color:var(--mw-ink,CanvasText);font:13px/1.4 system-ui,sans-serif}
      .mw-audio-bar label{display:flex;align-items:center;gap:5px;margin:0;white-space:nowrap}
      .mw-audio-bar select,.mw-audio-bar input[type=number],.mw-audio-bar button{box-sizing:border-box;min-height:28px;margin:0;padding:2px 6px;border:1px solid var(--mw-line,#8887);border-radius:5px;background:var(--mw-paper,Canvas);color:var(--mw-ink,CanvasText);font:inherit}
      .mw-audio-bar select{max-width:8rem}.mw-audio-bar input[type=number]{width:4rem}
      .mw-audio-bar input[type=range]{width:clamp(48px,9vw,92px);margin:0;accent-color:var(--mw-accent,AccentColor)}
      .mw-audio-bar output{min-width:3ch;font-variant-numeric:tabular-nums}
      .mw-audio-bar button:not(:disabled),.mw-playable{cursor:pointer}
      .mw-audio-bar button:disabled{opacity:.55}
      .mw-playable:focus-visible,.mw-playable[aria-pressed=true]{outline:2px solid var(--mw-accent,#6583dc);outline-offset:-2px}
      .mw-converted-midi{display:inline-block;color:var(--mw-accent,LinkText);font-size:.83em;text-underline-offset:.18em}
      .mw-converted-midi[hidden]{display:none}
      @media(max-width:480px){.mw-audio-bar{gap:4px 7px;padding-inline:5px}.mw-audio-bar label{gap:3px}.mw-audio-bar select{max-width:5.7rem}.mw-audio-bar input[type=number]{width:3rem}.mw-audio-bar input[type=range]{width:41px}.mw-audio-bar [data-audio-status]:empty{display:none}}
    `;
    document.head.append(style);
    if (upstream) return;
    toolbar = document.createElement('div');
    toolbar.className = 'mw-audio-bar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '试听设置');
    toolbar.innerHTML = '<label>音色 <select></select></label><label>BPM <input type="number" min="30" max="300" step="1" inputmode="numeric"></label><label>音量 <input type="range" min="0" max="100" step="1"><span data-volume></span></label><button type="button" disabled>停止</button><output data-audio-status aria-live="polite"></output>';
    const [instrument, bpm, volume] = toolbar.querySelectorAll('select,input');
    for (const [id, name] of instruments) instrument.add(new Option(name, id));
    instrument.value = settings.instrument;
    bpm.value = settings.bpm;
    volume.value = settings.volume;
    const showVolume = () => { toolbar.querySelector('[data-volume]').textContent = volume.value + '%'; };
    showVolume();
    instrument.addEventListener('change', () => setSetting('instrument', instrument.value));
    const changeBpm = () => {
      if (bpm.value && bpm.validity.valid) setSetting('bpm', bpm.valueAsNumber);
    };
    bpm.addEventListener('input', changeBpm);
    bpm.addEventListener('change', () => { changeBpm(); bpm.value = settings.bpm; });
    volume.addEventListener('input', () => { setSetting('volume', volume.valueAsNumber); showVolume(); });
    toolbar.querySelector('button').addEventListener('click', () => api.stop());
    const header = document.querySelector('[data-musicword-preview]');
    if (header) header.append(toolbar);
    else document.body.prepend(toolbar);
    renderStatus();
  }

  const api = {
    accept, attachImport, bindRoll, readMidi, play: upstream?.play ?? play,
    stop: upstream?.stop ?? (() => { if (current) finish(current, 'stopped'); }),
    get bpm() { return upstream?.bpm ?? settings.bpm; },
    restoreBpm: upstream?.restoreBpm ?? ((bpm) => {
      if (savedBpm || !Number.isInteger(bpm) || bpm < 30 || bpm > 300) return;
      setSetting('bpm', bpm);
      if (toolbar) toolbar.querySelector('input[type=number]').value = bpm;
    }),
    registerSamples: (name, bank) => rawSamples.set(name, bank),
  };
  window.MusicWordPreview = api;
  if (!upstream) {
    window.addEventListener('pagehide', api.stop);
    preloadBanks();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
