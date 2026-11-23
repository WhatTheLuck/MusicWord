"use strict";

const get = (id) => document.getElementById(id);
const previewAudio = window.MusicWordPreview;
let data = { rounds: [], songs: [], metrics: [] };
const stages = [
  ["input", "乐谱量化", "选择音轨，设置量化网格和高斯模糊，通过全曲缩略图移动时间窗口。"],
  ["trials", "初始化字典", "展开单词查看变体，回放随机候选的生成与筛选。"],
  ["variants", "相似度量", "点击单词预览展开词典，选择变体查看它在原谱上的响应。"],
  ["similarity", "匹配样例", "在各自的乐谱片段中滑动单词，比较匹配响应。白框标记最佳匹配，坐标为单词左下角相对乐谱原点的位置。"],
  ["matches", "拼图重构乐谱（裁切数据）", "每一步同时显示匹配前的变体排名、卷帘变化与新增裁切片段。"],
  ["learning", "字典重学习", "逐个单词查看音符基元如何组成新原型。"],
];

const playbackProgress = {
  trials: {
    label: "候选筛选回放",
    description: "一帧展示候选生成的一个步骤，或该候选的筛选结果。",
    position: (step, total) => `第 ${step + 1} 帧 / 共 ${total} 帧`,
  },
  matches: {
    label: "单词拼图回放",
    description: "初始为 0 次，每前进一步增加一次匹配。",
    position: (step, total) => step === 0
      ? `初始状态 · 共 ${total - 1} 次匹配`
      : `已匹配 ${step} / 共 ${total - 1} 次`,
  },
  learning: {
    label: "字典重学习回放",
    description: "播完一个单词的构建过程后，再切换到下一个单词。",
    position: (_step, _total, { word, index, wordCount, note, finished }) => {
      const phase = finished ? "学习结果"
        : note ? `添加第 ${note.count} 个基元 / 共 ${word.notes.length} 个` : "初始密度";
      return `${templateName(word.id)} · 单词 ${index + 1} / ${wordCount} · ${phase}`;
    },
  },
};
const state = { round: 0, song: 0, activeStage: "process" };
const symbols = {
  back: '<path d="M18 7l-6 5 6 5M7 7v10"/>',
  next: '<path d="M6 7l6 5-6 5M17 7v10"/>',
  play: '<path d="M9 6.5l8 5.5-8 5.5z" fill="currentColor" stroke-linejoin="round"/>',
  pause: '<path d="M9 6v12m6-12v12" stroke-width="3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const icon = (name) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name]}</svg>`;
const templateName = (id) => `T-${id}`;
const number = (value) => value.toFixed(3);
const colors = { notes: [156, 227, 191], dark: [20, 39, 34], response: [255, 160, 84],
  match: "#f79c78", capture: "#f2d38a" };
const plotTheme = { muted: "#b0c8bf" };
document.addEventListener("musicword:themechange", () => {
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--mw-chart").trim();
  if (/^#[0-9a-f]{6}$/i.test(background)) {
    colors.dark = background.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16));
  }
  plotTheme.muted = styles.getPropertyValue("--mw-chart-muted").trim() || plotTheme.muted;
  for (const canvas of document.querySelectorAll("canvas")) {
    const { top, bottom, width } = canvas.getBoundingClientRect();
    if (width && bottom > -150 && top < window.innerHeight + 150) plotDrawers.get(canvas)?.();
  }
});

const reconstructionCache = new WeakMap();
const decoded = new WeakMap();
const plotDrawers = new WeakMap();
const plotObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) plotDrawers.get(entry.target)();
  }
}, { rootMargin: "150px 0px" });
const plotSizer = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const rect = target.getBoundingClientRect();
    if (rect.bottom > -150 && rect.top < window.innerHeight + 150) plotDrawers.get(target)();
  }
});

function matrix(packet) {
  if (decoded.has(packet)) return decoded.get(packet);
  const [width, height, low, high, b64, precise] = packet;
  const raw = Uint8Array.from(atob(b64), (character) => character.charCodeAt(0));
  const values = precise
    ? new Float32Array(raw.buffer)
    : Float32Array.from(raw, (value) => low + value * (high - low) / 255);
  const result = { width, height, values, low, high };
  decoded.set(packet, result);
  return result;
}

function plot(title, values, options = {}) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", title);
  canvas.style.height = `${options.height || 115}px`;
  const source = options.blur && showBlur() ? gaussianView(values, ...options.blur) : values;
  plotDrawers.set(canvas, () => drawMatrix(canvas, source, options));
  if (options.preview !== false && (!options.heat || options.previewSource)) {
    previewAudio.bindRoll(canvas, (event) => rollClip(canvas, options.previewSource ?? values, options, event),
      `试听：${title}`, { pointerOnly: options.pointerOnly });
  }
  return canvas;
}

const rollGeometry = new WeakMap();
const rollNotes = new WeakMap();

function notesInRoll(source) {
  if (rollNotes.has(source)) return rollNotes.get(source);
  const notes = [];
  const { width, height, values } = source;
  for (let pitch = 0; pitch < height; pitch++) {
    let start = -1, peak = 0, previous = 0;
    for (let tick = 0; tick <= width; tick++) {
      const level = tick === width ? 0 : values[pitch * width + tick];
      const startsAgain = level >= .98 && (previous < .15 || previous >= .98);
      if (start >= 0 && (level < .004 || startsAgain)) {
        if (peak >= .12) notes.push([start, tick, pitch, 84]);
        start = -1;
        peak = 0;
      }
      if (level >= .004 && start < 0) start = tick;
      peak = Math.max(peak, level);
      previous = level;
    }
  }
  rollNotes.set(source, notes);
  return notes;
}

function rollClip(canvas, source, options, event) {
  const [start, end] = options.window ?? [0, source.width];
  let from = start, to = end, low = 0, high = source.height;
  const geometry = rollGeometry.get(canvas);
  if (event.type === "click" && geometry && options.boxes?.length) {
    const rect = canvas.getBoundingClientRect();
    const tick = start + (event.clientX - rect.left - geometry.left) / geometry.width * (end - start);
    const pitch = geometry.rows - (event.clientY - rect.top - geometry.top) / geometry.height * geometry.rows;
    const box = options.boxes.reduce((nearest, { box }) => {
      const [x1, y1, x2, y2] = box;
      if (tick < x1 || tick >= x2 || pitch < y1 || pitch > y2) return nearest;
      const area = (x2 - x1) * (y2 - y1);
      return !nearest || area < nearest.area ? { box, area } : nearest;
    }, null)?.box;
    if (box) {
      from = Math.max(start, box[0]);
      to = Math.min(end, box[2]);
      low = box[1];
      high = box[3];
    }
  }
  const center = options.previewPitch ?? options.pitchOrigin ?? Math.min(60, 128 - source.height);
  const notes = notesInRoll(source).filter(([on, off, pitch]) =>
    on < to && off > from && pitch >= low && pitch < high)
    .map(([on, off, pitch, velocity]) => [on, off, pitch + center, velocity]);
  return { notes, tpb: options.previewResolution ?? beatResolution(), from, to };
}

const blurredMatrices = new WeakMap();

function gaussianView(source, size, sigma) {
  if (size === 1) return source;
  const key = `${size}/${sigma}`;
  let cached = blurredMatrices.get(source);
  if (cached?.has(key)) return cached.get(key);
  if (!cached) blurredMatrices.set(source, cached = new Map());
  const { width, height, values } = source;
  const radius = (size - 1) / 2;
  const origin = Math.ceil(radius);
  const kernel = Array.from({ length: size }, (_, index) => Math.exp(-(((index - radius) / sigma) ** 2) / 2));
  const maximum = Math.max(...kernel);
  const weights = kernel.map(value => value / maximum);
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);
  let high = 0;
  for (let pitch = 0; pitch < height; pitch++) {
    const row = pitch * width;
    for (let tick = 0; tick < width; tick++) {
      for (let index = 0; index < size; index++) {
        const offset = tick + index - origin;
        if (offset >= 0 && offset < width) horizontal[row + tick] += values[row + offset] * weights[index];
      }
    }
  }
  for (let pitch = 0; pitch < height; pitch++) {
    for (let tick = 0; tick < width; tick++) {
      const cell = pitch * width + tick;
      for (let index = 0; index < size; index++) {
        const offset = pitch + index - origin;
        if (offset >= 0 && offset < height) result[cell] += horizontal[offset * width + tick] * weights[index];
      }
      high = Math.max(high, result[cell]);
    }
  }
  const blurred = { width, height, low: 0, high, values: result };
  cached.set(key, blurred);
  return blurred;
}

function drawMatrix(canvas, source, options) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const left = options.axes ? 23 : 0;
  const top = height < 12 && !options.axes ? 0 : 3;
  let plotWidth = width - left - 3;
  let plotHeight = height - top - (options.axes ? 18 : top);
  let plotTop = top;
  const [start, end] = options.window || [0, source.width];
  const visibleWidth = Math.max(1, end - start);
  if (options.wordDomain) {
    const [maxTicks, maxPitches] = options.wordDomain;
    const cell = Math.min(plotWidth / maxTicks, plotHeight / maxPitches);
    plotTop += plotHeight - cell * source.height;
    plotWidth = cell * visibleWidth;
    plotHeight = cell * source.height;
  }
  rollGeometry.set(canvas, { left, top: plotTop, width: plotWidth, height: plotHeight, rows: source.height });
  const pitchLimit = options.pitchLimit ?? source.height;
  const samples = Math.max(1, Math.min(visibleWidth, Math.ceil(plotWidth)));
  const heat = options.heat || false;
  const [low, high] = heat ? (options.heatBounds ?? [source.low, source.high]) : [0, 1];
  const range = high - low || 1;
  const raster = document.createElement("canvas");
  raster.width = samples;
  raster.height = source.height;
  const rasterContext = raster.getContext("2d");
  const pixels = rasterContext.createImageData(samples, source.height);
  for (let pitch = 0; pitch < source.height; pitch++) {
    for (let sample = 0; sample < samples; sample++) {
      const from = start + Math.floor(sample * visibleWidth / samples);
      const to = start + Math.floor((sample + 1) * visibleWidth / samples);
      let value = low;
      for (let tick = from; tick < to; tick++) value = Math.max(value, source.values[pitch * source.width + tick]);
      const strength = Math.max(0, Math.min(1, (value - low) / range));
      const index = ((source.height - pitch - 1) * samples + sample) * 4;
      const blend = heat ? strength ** 1.25 : Math.min(0.95, Math.sqrt(strength) * 1.1);
      const tone = heat ? [252, 191 + 36 * strength, 114 + 36 * strength] : colors.notes;
      const overlay = options.response;
      let alpha = 0;
      if (overlay && pitch < overlay.source.height) {
        const offset = overlay.offset ?? 0;
        const first = Math.max(0, Math.floor((from - offset) / overlay.stride));
        const last = Math.min(overlay.source.width, Math.ceil((to - offset) / overlay.stride));
        let peak = 0;
        for (let column = first; column < last; column++) {
          peak = Math.max(peak, overlay.source.values[pitch * overlay.source.width + column]);
        }
        alpha = 0.76 * Math.min(1, peak / Math.max(0.001, overlay.source.high));
      }
      for (let channel = 0; channel < 3; channel++) {
        const base = colors.dark[channel] + (tone[channel] - colors.dark[channel]) * blend;
        pixels.data[index + channel] = Math.round(base * (1 - alpha) + colors.response[channel] * alpha);
      }
      pixels.data[index + 3] = 255;
    }
  }
  rasterContext.putImageData(pixels, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(raster, left, plotTop, plotWidth, plotHeight);

  const toX = (tick) => left + (tick - start) * plotWidth / visibleWidth;
  const toY = (pitch) => plotTop + (source.height - pitch) * plotHeight / source.height;
  const offset = options.tickOffset || 0;
  const axisStep = (options.stride || 1);
  const ticks = options.axes ? (plotWidth < 150 ? 2 : plotWidth < 330 ? 4 : 7) : 0;
  context.font = "10px Consolas, monospace";
  context.fillStyle = plotTheme.muted;
  context.textAlign = "center";
  for (let index = 0; index <= ticks && ticks > 0; index++) {
    const x = left + 0.5 + (plotWidth - 1) * index / ticks;
    if (index > 0 && index < ticks) {
      context.fillStyle = "#ffffff16";
      context.fillRect(x, top, 1, plotHeight);
      context.fillStyle = plotTheme.muted;
    }
    context.textAlign = index === ticks ? "right" : (index === 0 ? "left" : "center");
    const tick = Math.min(end - 1, Math.round(start + visibleWidth * index / ticks));
    const globalTick = tick * axisStep + offset;
    context.fillText(String(Math.min(globalTick, options.realWidth ? options.realWidth - 1 : globalTick)), x, height - 4);
  }
  if (options.axes) {
    context.textAlign = "right";
    context.fillText(String(options.pitchOrigin ?? 0), left - 5, top + plotHeight);
    context.fillText(String((options.pitchOrigin ?? 0) + pitchLimit - 1), left - 5, top + 9);
  }
  context.save();
  context.beginPath();
  context.rect(left, plotTop, plotWidth, plotHeight);
  context.clip();
  for (const overlay of options.boxes || []) {
    const [x1, y1, x2, y2] = overlay.box;
    context.strokeStyle = overlay.color;
    context.lineWidth = overlay.lineWidth || 1.4;
    context.setLineDash(overlay.dashed ? [4, 3] : []);
    context.strokeRect(toX(x1), toY(y2), toX(x2) - toX(x1), toY(y1) - toY(y2));
  }
  context.restore();
}

function figure(title, packet, options = {}, subtitle = "") {
  const element = document.createElement("figure");
  element.className = "figure";
  const dark = document.createElement("div");
  dark.className = "figure-dark";
  if (packet) {
    let source = Array.isArray(packet) ? matrix(packet) : packet;
    const [width, height] = options.domain ?? [source.width, source.height];
    if (width !== source.width || height !== source.height) {
      const values = new Float32Array(width * height);
      for (let row = 0; row < source.height; row++) {
        values.set(source.values.subarray(row * source.width, (row + 1) * source.width), row * width);
      }
      source = { ...source, width, height, values };
    }
    dark.append(plot(title, source, options));
  }
  else {
    dark.style.minHeight = `${(options.height || 115) + 14}px`;
    dark.style.color = "var(--chart-muted)";
    dark.textContent = "空缺";
  }
  const caption = document.createElement("figcaption");
  caption.className = "figure-caption";
  const label = document.createElement("strong");
  label.textContent = title;
  caption.append(label, subtitle ? ` · ${subtitle}` : "");
  element.append(dark, caption);
  return element;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function figures(items, className = "") {
  const group = element("div", `figures ${className}`);
  group.append(...items);
  return group;
}

function facts(entries) {
  const list = element("dl", "facts");
  for (const [label, value] of entries) {
    const item = document.createElement("div");
    item.append(element("dt", "", label), element("dd", "", value));
    list.append(item);
  }
  return list;
}

function stageValue(view, value, label) {
  view.closest(".playback-stage").querySelector('[data-part="value"]')
    .replaceChildren(element("strong", "", value), document.createTextNode(label));
}

function plotRow(section, title, values, options) {
  const row = element("div", "plot-row");
  row.append(element("span", "plot-label", title), plot(title, values, options));
  section.append(row);
}

function plotSection(title, legend = []) {
  const block = element("section", "plot-section");
  const toolbar = element("div", "plot-toolbar");
  toolbar.append(element("h3", "", title));
  if (legend.length) {
    const list = element("div", "legend");
    for (const [style, text] of legend) {
      const item = element("span", "");
      item.append(element("i", `swatch ${style}`), text);
      list.append(item);
    }
    toolbar.append(list);
  }
  block.append(toolbar);
  return block;
}

const currentSong = () => data.songs[state.song];
const currentRound = () => data.rounds[state.round];
const beatResolution = () => data.resolution ?? 24;
const windowSizes = [4, 8, 16, 32];
const windowBeats = () => windowSizes[Number(get("window-size").value)];
const showBlur = () => get("blurred").checked;
const blurSettings = (kind = "random") => {
  const config = data.config;
  if (kind === "reference") return [config?.reference_blur_size ?? 5, config?.reference_sigma ?? 2];
  if (kind === "density") return [config?.spawn_blur_size ?? 3, config?.spawn_sigma ?? 1];
  return [config?.blur_size ?? 5, kind === "learned" ? config?.learned_sigma ?? 1 : config?.random_sigma ?? 1.25];
};
const displayedVariant = (variant) => showBlur() ? variant?.blurred ?? variant?.matrix : variant?.matrix;
const songAxes = (song) => ({
  axes: true, pitchOrigin: song.pitchOrigin, tickOffset: song.tickOrigin - song.timePad,
});
const matchBox = (box) => ({ box, color: colors.match, lineWidth: 1.8 });
const variantName = (item) => `${templateName(item.template)} · ${item.scale}×`;
const originalParameters = "F=0 D=0 A=0";
const variantParameters = "F=0 D=1 A=1";
const variantParameterGuide = "原体用 0 标记未施加的变换。变体中的 F 表示翻转，D 是时值倍率，A 是音符起点间距倍率。";
const pitchMultiplier = (scale) => `音高 ${scale}×`;
let inputPreview = null;
let selectedVariant = null;
let similarityExamples = [];
const similarityMetric = element("select", "similarity-metric");
similarityMetric.id = "similarity-metric";
const similarityMetrics = [
  ["BACC（加权 Dice）", "bacc"],
  ["ZNCC（零均值归一化互相关）", "zncc"],
  ["RMSE（均方根误差）", "rmse"],
];
const similarityNotes = {
  bacc: "按单词和乐谱窗口的激活能量归一化，重合越多，分数越高。",
  zncc: "比较去均值后的相关性，负相关在色标上显示为 0。",
  rmse: "色标为 1 − RMSE ÷ 样例的最大激活值（最低取 1）。图注同时显示原始误差。",
};

function windowAt(width, center, span = windowBeats() * beatResolution()) {
  span = Math.min(width, span);
  const start = Math.max(0, Math.min(width - span, Math.round(center - span / 2)));
  return [start, start + span];
}

function viewport(view, source, panel, section, visible, boxes = [], step) {
  if (visible[1] - visible[0] === source.width) {
    view.append(section);
    return;
  }
  const overview = element("div", "overview");
  const track = element("div", "overview-track");
  track.append(plot("全曲缩略图", source, { height: 54, boxes, preview: false }));
  overview.append(track);
  view.append(overview, section);
  bindTimeWindow(track, source, panel, section, visible, step);
}

function bindTimeWindow(track, source, panel, section, visible, step = beatResolution()) {
  const marker = element("span", "overview-marker");
  const span = visible[1] - visible[0];
  let frame = 0;
  track.tabIndex = 0;
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "时间窗口位置");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", String(source.width - span));
  function move(center) {
    const [start, end] = windowAt(source.width, center, span);
    visible[0] = start;
    visible[1] = end;
    panel.center = start + span / 2;
    marker.style.left = `${100 * start / source.width}%`;
    marker.style.width = `${100 * span / source.width}%`;
    track.setAttribute("aria-valuenow", String(start));
    track.setAttribute("aria-valuetext", `第 ${start} 至 ${end - 1} 格`);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (!track.isConnected) return;
      for (const plot of section.querySelectorAll("canvas")) plotDrawers.get(plot)();
    });
  }
  const point = (event) => {
    const rect = track.getBoundingClientRect();
    return (event.clientX - rect.left) * source.width / rect.width;
  };
  let offset = 0;
  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    track.setPointerCapture(event.pointerId);
    offset = event.target === marker ? point(event) - visible[0] - span / 2 : 0;
    move(point(event) - offset);
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture(event.pointerId)) move(point(event) - offset);
  });
  track.addEventListener("keydown", (event) => {
    const center = visible[0] + span / 2;
    const centers = { ArrowLeft: center - step, ArrowRight: center + step,
      Home: 0, End: source.width };
    if (!Object.hasOwn(centers, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    move(centers[event.key]);
  });
  track.append(marker);
  move(visible[0] + span / 2);
}

function legacyPreview(song) {
  const source = matrix(song.roll);
  const width = source.width - 2 * song.timePad;
  const height = source.height - song.pitchPad;
  return { ...song, resolution: beatResolution(), source: {
    width, height, values: Float32Array.from({ length: width * height }, (_, index) =>
      source.values[Math.floor(index / width) * source.width + index % width + song.timePad]),
  } };
}

function viewInput(view, panel) {
  const song = currentSong();
  const preview = inputPreview ?? song?.preview ?? (song && legacyPreview(song));
  if (!preview) {
    view.append(element("p", "stage-status", "选择一首 POP909 曲目或导入本地 MIDI。"));
    return;
  }
  const raw = preview.source ?? matrix(preview.roll);
  const blurred = showBlur();
  const source = !blurred ? raw : preview.blurred ? matrix(preview.blurred) : gaussianView(raw, ...blurSettings());
  const span = windowBeats() * preview.resolution;
  const overlay = inputAnnotationOverlay(preview, raw);
  const recorded = !inputAnnotations && song && preview.resolution === beatResolution()
    ? (song.boxes ?? []).map(([left, low, right, high]) => ({
      box: [left - song.timePad, low, right - song.timePad, high], color: colors.capture, dashed: true,
    })) : [];
  const annotations = overlay ?? recorded;
  const previous = panel.previewAxis;
  if (panel.center != null && previous && previous.resolution !== preview.resolution) {
    panel.center = (panel.center + previous.tickOrigin) * preview.resolution / previous.resolution - preview.tickOrigin;
  }
  panel.previewAxis = preview;
  const visible = windowAt(raw.width, panel.center ?? span / 2, span);
  const legend = annotations.length ? [["capture", `人工标注 · ${annotations.length} 个片段`]] : [];
  const section = plotSection(blurred ? "模糊后卷帘" : "量化钢琴卷帘", legend);
  plotRow(section, "MIDI 音高", source, {
    height: 242, axes: true, heat: Boolean(blurred), window: visible,
    pitchOrigin: preview.pitchOrigin, tickOffset: preview.tickOrigin,
    previewSource: raw, previewResolution: preview.resolution,
    boxes: annotations,
  });
  stageValue(view, String(preview.notes), "个音符");
  viewport(view, raw, panel, section, visible, annotations, preview.resolution);
  view.append(facts([
    ["量化网格", `${preview.resolution} tick/拍`],
    ["音域", `${preview.pitchOrigin}–${preview.pitchOrigin + raw.height - 1}`],
    ["总长度", `${(raw.width / preview.resolution).toFixed(1)} 拍`],
    ["训练输入音高行", String(raw.height + (preview.pitchPad ?? song?.pitchPad ?? 0))],
  ]));
}

const annotationGroups = new WeakMap();
const embeddedAnnotations = JSON.parse(get("recorded-annotations")?.textContent ?? "{}");
let annotationCatalog;

async function fetchAnnotations(key, signal) {
  const response = await fetch(new URL(`annotations/${key}.json`, document.baseURI), { signal });
  if (!response.ok) throw new Error("标注文件无法读取。");
  return response.json();
}

function annotationIndex() {
  return annotationCatalog ??= fetchAnnotations("index").catch((error) => {
    annotationCatalog = null;
    throw error;
  });
}

async function trackAnnotations(song, track, signal) {
  if (location.protocol === "file:") return embeddedAnnotations[song] ?? null;
  if (!/^\d{3}$/.test(song ?? "")) return null;
  const songs = await annotationIndex();
  if (signal?.aborted) return null;
  const entry = songs.find((item) => item.id === song)?.tracks.find((item) => item.id + 1 === track);
  return entry ? fetchAnnotations(entry.key, signal) : null;
}

function groupedAnnotations(version) {
  if (annotationGroups.has(version)) return annotationGroups.get(version);
  const colors = new Map();
  const instances = version.instances.filter(({ notes }) => notes.length).map(({ group, notes, color }) => {
    if (!colors.has(group)) colors.set(group, color ?? `hsl(${(40 + colors.size * 137.5) % 360} 85% 73%)`);
    const pitches = notes.map(([pitch]) => pitch);
    return { group, notes, color: colors.get(group),
      start: Math.min(...notes.map(([, start]) => start)),
      end: Math.max(...notes.map(([, , end]) => end)),
      low: Math.min(...pitches), high: Math.max(...pitches) + 1 };
  }).sort((a, b) => a.start - b.start);
  const result = { instances, colors };
  annotationGroups.set(version, result);
  return result;
}

function refreshChoices(select, choices, current) {
  select.replaceChildren(...choices.map(([label, value]) => new Option(label, value)));
  if (choices.some(([, value]) => String(value) === String(current))) select.value = current;
  select.disabled = !choices.length;
  return select.value;
}

function chooseVariant(index, jump = false) {
  const panel = panels.find((item) => item.key === "variants");
  selectedVariant = index;
  for (const card of panel.parts.responseDictionary.querySelectorAll("[data-variant]")) {
    card.setAttribute("aria-pressed", String(Number(card.dataset.variant) === index));
  }
  panel.center = null;
  render(panel);
  if (jump) location.hash = panel.section.id;
}

function viewResponseDictionary(view, round) {
  const variantsByWord = new Map();
  const wordDomain = wordDimensions([...round.dictionary, ...round.variants.map(displayedVariant)]);
  for (const [index, item] of round.variants.entries()) {
    if (!variantsByWord.has(item.template)) variantsByWord.set(item.template, []);
    variantsByWord.get(item.template).push({ index, item });
  }
  round.dictionary.forEach((packet, word) => {
    if (!packet) return;
    const name = templateName(word);
    const variants = variantsByWord.get(word) ?? [];
    const row = element("div", "response-word-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", name);
    const original = figure(`${name} · 原体`, packet, { height: 58, wordDomain });
    original.classList.add("response-original");
    original.lastElementChild.append(element("span", "variant-parameters", originalParameters));
    const strip = element("div", "response-word-strip");
    for (const { index, item } of variants) {
      const choice = responseChoice(pitchMultiplier(item.scale), displayedVariant(item), variantParameters,
        { height: 58, wordDomain });
      choice.disabled = !item.responses[state.song];
      choice.dataset.variant = index;
      choice.setAttribute("aria-pressed", String(index === selectedVariant));
      choice.addEventListener("click", () => chooseVariant(index));
      strip.append(choice);
    }
    if (!variants.length) strip.append(element("p", "helper", "本轮无可用变体。"));
    row.append(original, strip);
    view.append(row);
  });
  watchPlots(view);
}

function responseChoice(text, packet, parameters, options) {
  const button = element("button", "variant-choice response-choice");
  button.type = "button";
  const thumbnail = plot(text, matrix(packet), { ...options, pointerOnly: true });
  thumbnail.setAttribute("aria-hidden", "true");
  button.append(thumbnail, element("span", "", text), element("span", "variant-parameters", parameters));
  return button;
}

function viewDictionary(view, round) {
  const config = data.config;
  const scales = config?.pitch_scales ?? [...new Set(round.variants.map((item) => item.scale))];
  if (scales.length) view.append(facts([
    ["变体音高倍率", `${Math.min(...scales)}–${Math.max(...scales)}×`],
    ["离散倍率", scales.map((scale) => `${scale}×`).join("、")],
    ["原型初始形状", config?.initial_shape.join(" × ") ?? "见参数文件"],
  ]), element("p", "helper variant-guide", variantParameterGuide));
  const grid = element("div", "dictionary-grid");
  const wordDomain = wordDimensions([...round.dictionary, ...round.variants.map(displayedVariant)]);
  round.dictionary.forEach((packet, index) => {
    const details = element("details", "word");
    const summary = element("summary", "");
    summary.append(figure(templateName(index), packet, { height: 62, wordDomain, pointerOnly: true }, packet ? originalParameters : ""));
    const variants = element("div", "word-variants");
    round.variants.forEach((item, id) => {
      if (item.template !== index) return;
      const button = element("button", "variant-choice");
      button.type = "button";
      button.append(figure(pitchMultiplier(item.scale), displayedVariant(item), { height: 54, wordDomain, pointerOnly: true }, variantParameters));
      button.disabled = !item.responses[state.song];
      button.addEventListener("click", () => chooseVariant(id, true));
      variants.append(button);
    });
    if (!variants.children.length) variants.append(element("p", "helper", "本轮无可用变体。"));
    details.append(summary, variants);
    grid.append(details);
  });
  view.append(grid);
}

function trialFrames(round) {
  return round.trials.flatMap((trial) => {
    if (trial.learned || !trial.notes?.length) return [{ trial }];
    return Array.from({ length: trial.notes.length + 1 }, (_, count) => ({ trial, count }));
  });
}

function viewTrial(view, round, frame) {
  if (!frame) return;
  const { trial, count } = frame;
  const building = count !== undefined && count < trial.notes.length;
  const status = building ? `已放入 ${count} / ${trial.notes.length} 个音符`
    : trial.accepted ? "入选字典"
      : trial.similarity != null ? "与已有音形过于相似"
        : trial.response == null ? "没有可计算的匹配位置" : "最高匹配分数低于入选门槛";
  const section = plotSection(`字典槽位 ${templateName(trial.template)}`, [
    ["", "音符起点"], ["sustain", "音符延续"],
  ]);
  const decision = element("span", "trial-decision");
  if (!building) {
    const mark = element("span", `trial-mark ${trial.accepted ? "accepted" : "rejected"}`);
    mark.innerHTML = icon(trial.accepted ? "check" : "cross");
    decision.append(mark);
  }
  decision.append(status);
  section.querySelector("h3").append(decision);
  const source = matrix(trial.matrix);
  const values = building ? new Float32Array(source.values.length) : source.values;
  if (building) {
    for (const [tick, pitch, duration] of trial.notes.slice(0, count)) {
      const start = pitch * source.width + tick;
      values[start] = 1;
      values.fill(0.01, start + 1, pitch * source.width + Math.min(source.width, tick + Math.max(1, duration)));
    }
  }
  const note = building && count ? trial.notes[count - 1] : null;
  plotRow(section, "相对音高（半音）", { ...source, values }, {
    height: 126, axes: true, blur: blurSettings(trial.learned ? "learned" : "random"),
    boxes: note ? [matchBox([note[0], note[1], note[0] + 1, note[1] + 1])] : [],
  });
  section.append(element("p", "trial-time-axis", "相对时间（tick，量化后的时间格）"));
  view.append(section);
  if (building) return;

  const entries = [["音符基元数", String(trial.count)]];
  const isSimilarity = trial.similarity != null;
  const score = isSimilarity ? trial.similarity : trial.response;
  const threshold = isSimilarity ? data.uniqueness : data.usefulness;
  if (score != null) {
    const sameWhenRounded = Number.isFinite(threshold) && score !== threshold && number(score) === number(threshold);
    entries.push([isSimilarity ? "与已有音形的相似度" : "输入音轨最高匹配分数", sameWhenRounded ? String(score) : number(score)]);
    if (Number.isFinite(threshold)) {
      entries.push([isSimilarity ? "相似度上限" : "入选门槛", sameWhenRounded ? String(threshold) : number(threshold)]);
    }
  }
  view.append(facts(entries));
  if (trial.comparisons) viewTrialComparisons(view, round, trial);
  else if (isSimilarity) view.append(element("p", "helper", "这份回放没有记录比较对象，重新运行训练后可查看连线。"));
}

function viewTrialComparisons(view, round, trial) {
  if (!trial.comparisons.length) {
    view.append(element("p", "helper", "生成这个候选时，字典里还没有其他单词。"));
    return;
  }
  const section = element("section", "trial-comparisons");
  section.append(element("h4", "subheading", "与已有单词的相似度"));
  const graph = element("div", "trial-graph");
  const candidate = element("div", "trial-graph-source");
  candidate.append(figure(`候选 ${templateName(trial.template)}`, trial.matrix, { height: 38, blur: blurSettings() }));
  const references = element("div", "trial-graph-references");
  for (const [word, score] of trial.comparisons) {
    const exceedsLimit = score > data.uniqueness;
    const row = element("div", `trial-graph-row${exceedsLimit ? " exceeds-limit" : ""}`);
    const link = element("span", "trial-graph-link");
    const label = number(score) === number(data.uniqueness) && score !== data.uniqueness ? String(score) : number(score);
    link.append(element("span", "", exceedsLimit ? `${label} 超限` : label));
    row.append(link, figure(templateName(word), round.trialReferences?.[trial.template]?.[word],
      { height: 38, blur: blurSettings("reference") }));
    references.append(row);
  }
  graph.append(candidate, references);
  section.append(graph, element("p", "helper", `相似度上限 ${number(data.uniqueness)}。超过上限的候选不进入字典。`));
  view.append(section);
}

const idealSimilarities = new Map([
  ["完全相同", "最高"],
  ["整体平移", "与完全相同等值"],
  ["单词音符较少", "低于完全相同"],
  ["单词音符较多", "低于完全相同"],
  ["微调起点和时长", "低于完全相同，但仍较高"],
  ["一个音符音高改变", "低于完全相同"],
  ["音高方向反转", "较低"],
]);

function viewSimilarity(view) {
  if (!similarityExamples.length) {
    view.append(element("p", "stage-status", live ? "正在计算匹配样例…" : "暂无匹配样例。"));
    return;
  }
  const metric = similarityMetric.value;
  const maps = similarityExamples.flatMap(({ responseMap }) => responseMap ? [responseMap.matrix] : []);
  const heatBounds = metric ? [0, 1] : [
    Math.min(...maps.map((packet) => matrix(packet).low)),
    Math.max(...maps.map((packet) => matrix(packet).high)),
  ];
  const axes = { height: 100, axes: true };
  for (const example of similarityExamples) {
    const sample = element("article", "similarity-sample");
    sample.append(element("h4", "subheading", example.label));
    if (example.description) sample.append(element("p", "helper", example.description));
    const plots = element("div", "similarity-plots");
    const noteCount = (count) => count == null ? "" : `${count} 个音符`;
    const result = example.scores?.[metric] ?? example;
    const kernel = showBlur() && result.matchKernel;
    plots.append(
      figure(kernel ? "单词匹配核" : "单词", kernel || example.left,
        { ...axes, previewSource: matrix(example.left), blur: kernel ? null : example.wordBlur ?? blurSettings() }, noteCount(example.wordNotes)),
      figure("乐谱片段", example.right, axes, noteCount(example.targetNotes)),
    );
    const map = result.responseMap;
    if (map) {
      const [pitch, tick] = map.position;
      const rmse = result.rmse == null ? "" : ` · RMSE ${number(result.rmse)}`;
      const ideal = idealSimilarities.get(example.label);
      const expectation = ideal ? ` · 理想相似度：${ideal}` : "";
      const peak = `峰值 ${number(result.response)}${rmse}${expectation} · ${pitchMultiplier(result.scale)} · 音高 ${pitch + map.origin} 半音，时间 ${tick + map.origin} tick`;
      const chart = element("div", "similarity-response");
      chart.append(figure("匹配响应图", map.matrix, {
        ...axes, heat: true, heatBounds, pitchOrigin: map.origin, tickOffset: map.origin,
        boxes: [{ box: [tick, pitch, tick + 1, pitch + 1], color: "#ffffff" }],
      }, peak));
      if (example.scores?.[metric]) {
        const legend = element("div", "similarity-scale");
        legend.setAttribute("aria-hidden", "true");
        const gradient = element("div", "similarity-gradient");
        gradient.style.setProperty("--peak", `${(1 - result.response) * 100}%`);
        legend.append(element("span", "", "1"), gradient, element("span", "", "0"));
        chart.append(legend);
      }
      plots.append(chart);
    } else {
      plots.append(element("p", "helper", "这份旧回放缺少匹配响应图，请在本地工作台打开以重新计算。"));
    }
    sample.append(plots);
    view.append(sample);
  }
}

function responsePeak(response) {
  if (response.position) return [response.position[1], response.position[0]];
  const source = matrix(response.matrix);
  let highest = 0;
  for (let i = 1; i < source.values.length; i++) if (source.values[i] > source.values[highest]) highest = i;
  return [(highest % source.width) * response.stride, Math.floor(highest / source.width)];
}

function viewVariant(view, round, song, panel) {
  const item = round.variants[selectedVariant];
  const response = item?.responses[state.song];
  const dictionary = panel.parts.responseDictionary;
  const dialog = panel.parts.responseDialog;
  const toggle = item
    ? responseChoice(`${templateName(item.template)} · ${pitchMultiplier(item.scale)}`,
      displayedVariant(item), variantParameters, { height: 206, axes: true })
    : button("", "action-button");
  toggle.classList.add("response-preview");
  toggle.append(element("span", "response-toggle-label", "展开词典"));
  toggle.setAttribute("aria-haspopup", "dialog");
  toggle.setAttribute("aria-controls", dialog.id);
  toggle.addEventListener("click", () => {
    if (!dictionary.hasChildNodes()) viewResponseDictionary(dictionary, round);
    dialog.showModal();
  });
  if (!response) {
    view.append(element("p", "stage-status", "本轮在这个音轨上没有可用的变体响应。"));
    if (round.dictionary.some(Boolean)) view.append(toggle);
    return;
  }
  const source = matrix(song.roll);
  const [tick, pitch] = responsePeak(response);
  const visible = windowAt(source.width, panel.center ?? tick);
  const overlay = { source: matrix(response.matrix), stride: response.stride };
  const section = plotSection("响应叠加原谱", [["", "原谱音符"], ["response", "正响应"], ["match", "峰值位置"]]);
  plotRow(section, "MIDI 音高", source, {
    ...songAxes(song), height: 200, window: visible, response: overlay,
    boxes: [matchBox([tick, pitch, tick + (response.position ? 1 : response.stride), pitch + 1])],
  });
  stageValue(view, number(response.peak), "最高响应");
  const layout = element("div", "response-layout");
  layout.append(toggle);
  const responseView = element("div", "response-main");
  viewport(responseView, source, panel, section, visible);
  layout.append(responseView);
  view.append(layout, element("p", "helper", `时间按每 ${response.stride} 格取最大响应，热图位置对应匹配核的左下角。`));
}

function accumulate(output, kernel, at) {
  for (let pitch = 0; pitch < kernel.height; pitch++) {
    for (let tick = 0; tick < kernel.width; tick++) {
      output[(at[1] + pitch) * at[2] + at[0] + tick] += kernel.values[pitch * kernel.width + tick];
    }
  }
}

function encodedThrough(round, song, events, last, includeResidual = false) {
  const source = matrix(song.roll);
  let cache = reconstructionCache.get(events);
  if (!cache || cache.last > last || Boolean(cache.subtracted) !== includeResidual) {
    cache = {
      last: -1, values: new Float32Array(source.values.length),
      subtracted: includeResidual ? new Float32Array(source.values.length) : null,
      variants: new Map(round.variants.map((item) => [variantName(item), item])),
    };
    reconstructionCache.set(events, cache);
  }
  while (cache.last < last) {
    const event = events[++cache.last];
    const variant = cache.variants.get(variantName(event));
    const [tick, pitch] = event.box;
    accumulate(cache.values, matrix(variant.matrix), [tick, pitch, source.width]);
    if (cache.subtracted) accumulate(cache.subtracted, matrix(variant.blurred), [tick, pitch, source.width]);
  }
  return cache;
}

function rankingRange(initial, events) {
  let low = 0;
  let high = 0;
  function include(score) {
    low = Math.min(low, score);
    high = Math.max(high, score);
  }
  for (const [, , score] of initial) include(score);
  for (const event of events) {
    include(event.score);
    for (const [, , score] of event.ranking ?? []) include(score);
  }
  return [low, high];
}

function rankingList(ranking, variants, event, [low, high]) {
  const list = element("ol", "ranking");
  list.dataset.matchScroll = "ranking";
  const width = high - low || 1;
  const zero = (0 - low) * 100 / width;
  list.style.setProperty("--ranking-zero", `${zero}%`);
  for (const [word, scale, score] of ranking) {
    const isWinner = event?.template === word && event?.scale === scale;
    const row = element("li", isWinner ? "winner" : "");
    if (isWinner) row.setAttribute("aria-current", "true");
    const title = `${templateName(word)} · ${pitchMultiplier(scale)}`;
    const entry = element("div", "ranking-entry");
    const thumbnail = element("div", "ranking-thumbnail");
    const packet = displayedVariant(variants.get(variantName({ template: word, scale })));
    thumbnail.append(packet ? plot(`${title}的音形`, matrix(packet), { height: 44 }) : "音形缺失");
    const track = element("span", "ranking-bar");
    track.setAttribute("aria-hidden", "true");
    const fill = element("span", score < 0 ? "negative" : "");
    fill.style.left = `${(Math.min(0, score) - low) * 100 / width}%`;
    fill.style.width = `${Math.abs(score) * 100 / width}%`;
    track.append(fill);
    entry.append(thumbnail, element("span", "ranking-name", title),
      element("strong", "ranking-score", number(score)), track);
    row.append(entry);
    list.append(row);
  }
  return list;
}

function capturePreview(capture) {
  return figures([
    figure("原谱裁切", capture.crop, { height: 34 }),
    figure("逆变换", capture.restored, { height: 34 }),
  ], "capture-pair");
}

function captureHistogram(view, round, panel) {
  const groups = round.dictionary.map(() => []);
  const added = [];
  for (const capture of round.captures) {
    if (capture.song !== state.song || capture.match >= panel.step) continue;
    groups[panel.matches[capture.match].template].push(capture);
    if (capture.match === panel.step - 1) added.push(capture);
  }
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const header = element("div", "capture-panel-heading");
  header.append(element("h3", "subheading", "裁切数据集"), element("span", "capture-total", `累计 ${total} 个`));
  const matchedWord = panel.matches[panel.step - 1]?.template;
  const update = added.length ? `本步 ${templateName(matchedWord)} +${added.length}`
    : panel.step ? "本步未新增片段" : "初始状态，尚未裁切";

  const grid = captureBins(groups.entries(), round.dictionary, { columns: 2, latest: panel.step - 1 });
  const body = element("div", "capture-panel-body");
  body.dataset.matchScroll = "captures";
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", "按字典单词分组的裁切片段");
  body.append(grid);
  view.append(header, element("p", "capture-update", update), body);
  if (added.length) {
    const current = element("div", "capture-current");
    for (const capture of added) current.append(capturePreview(capture));
    view.append(current);
  }
}

function captureBins(groups, dictionary, { columns = 1, latest, inspect, nameFor = templateName, topDown = false }) {
  const grid = element("div", "capture-grid");
  grid.style.setProperty("--capture-columns", columns);
  let maxRows = 1;
  for (const [word, captures] of groups) {
    maxRows = Math.max(maxRows, Math.ceil(captures.length / columns));
    const name = nameFor(word);
    const column = element("section", "capture-bin");
    const summary = element("h4", "capture-bin-label");
    const label = inspect && captures.length ? button("", "capture-bin-trigger") : summary;
    label.classList.add("capture-bin-key");
    label.append(element("strong", "", name));
    const original = dictionary[word];
    if (original) {
      const title = `${name} 原体`;
      const thumbnail = plot(title, Array.isArray(original) ? matrix(original) : original,
        { height: 18, pointerOnly: label !== summary });
      thumbnail.classList.add("capture-bin-original");
      thumbnail.title = title;
      label.append(thumbnail);
    }
    label.append(element("span", "capture-bin-count", String(captures.length)));
    if (label !== summary) {
      label.setAttribute("aria-expanded", "false");
      label.setAttribute("aria-label", `${name} 的 ${captures.length} 个片段`);
      label.addEventListener("click", () => inspect(word, captures, label));
      summary.append(label);
    }
    const stack = element("ol", "capture-stack");
    stack.reversed = !topDown;
    for (let row = 0; row < captures.length; row++) {
      const index = topDown ? row : captures.length - 1 - row;
      const capture = captures[index];
      const { crop, match } = capture;
      const item = element("li", match != null && match === latest ? "capture-added" : "");
      const label = `${name} 第 ${index + 1} 个片段${match == null ? "" : `，匹配步骤 ${match + 1}`}`;
      item.title = label;
      item.append(plot(label, Array.isArray(crop) ? matrix(crop) : crop));
      stack.append(item);
    }
    column.append(...(topDown ? [summary, stack] : [stack, summary]));
    grid.append(column);
  }
  grid.style.setProperty("--capture-rows", maxRows);
  return grid;
}

function matchesFor(round) {
  return round.matches.filter((item) => item.song === state.song);
}

function capturesByWord(round) {
  const bySong = data.songs.map(() => []);
  for (const event of round.matches) bySong[event.song].push(event);
  const groups = round.dictionary.map(() => []);
  for (const capture of round.captures ?? []) {
    const word = bySong[capture.song]?.[capture.match]?.template;
    groups[word]?.push(capture);
  }
  return groups;
}

function matchDictionary(round, currentWord) {
  const section = element("section", "encoding-dictionary");
  const heading = element("h3", "subheading", "字典原体");
  heading.id = "encoding-dictionary-heading";
  section.setAttribute("aria-labelledby", heading.id);
  const list = element("ul", "encoding-dictionary-list");
  list.dataset.matchScroll = "dictionary";
  round.dictionary.forEach((packet, word) => {
    if (!packet) return;
    const name = templateName(word);
    const item = element("li", "encoding-dictionary-word");
    if (word === currentWord) item.setAttribute("aria-current", "true");
    const thumbnail = plot(`${name} 原体`, matrix(packet), { height: 22 });
    item.append(thumbnail, element("span", "", name));
    list.append(item);
  });
  section.append(heading, list.childElementCount ? list : element("p", "helper", "暂无单词"));
  return section;
}

function viewMatch(view, round, song, panel) {
  const source = matrix(song.roll);
  const events = panel.matches;
  const last = panel.step - 1;
  const event = events[last];
  const visible = windowAt(source.width, panel.center ?? (event ? (event.box[0] + event.box[2]) / 2 : 0));
  const clipped = visible[1] - visible[0] < source.width;
  const boxes = event ? [matchBox(event.box)] : [];
  const pitchMargin = data.config?.capture_pitch_margin ?? data.captureMargin ?? 0;
  const timeMargin = data.config?.capture_time_margin ?? data.captureMargin ?? 0;
  const originalBoxes = [...boxes];
  if (event && (pitchMargin || timeMargin)) {
    const [left, bottom, right, top] = event.box;
    originalBoxes.unshift({
      box: [Math.max(0, left - timeMargin), Math.max(0, bottom - pitchMargin),
        Math.min(source.width, right + timeMargin), Math.min(source.height, top + pitchMargin)],
      color: colors.capture, dashed: true,
    });
  }
  const encoded = encodedThrough(round, song, events, last, true);
  const residual = Float32Array.from(source.values, (value, index) => Math.max(0, value - encoded.subtracted[index]));
  const axes = songAxes(song);
  const ranking = element("aside", "ranking-panel");
  const rankingHeading = element("div", "ranking-heading");
  rankingHeading.append(element("h3", "", "变体响应排名"));
  const entries = event ? (event.ranking ?? [[event.template, event.scale, event.score]]) : panel.initialRanking;
  if (entries.length) {
    const [low, high] = panel.responseRange;
    const parameters = element("span", "ranking-scale", variantParameters);
    parameters.title = variantParameterGuide;
    rankingHeading.append(element("span", "ranking-scale", `${number(low)} 至 ${number(high)}`), parameters);
  }
  ranking.append(rankingHeading);
  if (event && !event.ranking) ranking.append(element("p", "helper", "这份回放仅记录了胜出变体的分值。"));
  ranking.append(entries.length ? rankingList(entries, encoded.variants, event, panel.responseRange)
    : element("p", "helper", "没有可匹配的变体。"));
  const rows = [["原始 MIDI", source, { boxes: originalBoxes }]];
  if (event) {
    const [tick, pitch] = event.box;
    rows.push(["本步响应", source, {
      boxes: [matchBox([tick, pitch, tick + 1, pitch + 1])],
      response: { source: matrix(event.before), stride: 1, offset: event.start },
    }]);
  }
  rows.push(["残差 MIDI", { ...source, values: residual }, { boxes }]);
  const variant = event && encoded.variants.get(variantName(event));
  const rawBox = variant && [event.box[0], event.box[1], event.box[0] + matrix(variant.matrix).width,
    event.box[1] + matrix(variant.matrix).height];
  rows.push(["重构 MIDI", { ...source, values: encoded.values }, { boxes: rawBox ? [matchBox(rawBox)] : [] }]);

  const legends = [["", "音符"], ["match", "本步命中"]];
  if (originalBoxes.length > boxes.length) legends.push(["capture", "裁切范围"]);
  const full = plotSection("全曲对齐卷帘", legends);
  const detail = plotSection("局部放大");
  detail.classList.add("encoding-detail");
  const earlierBoxes = events.slice(0, last < 0 ? 0 : last).map((item) => ({
    box: item.box, color: "#86b1a378", lineWidth: 1,
  }));
  rows.forEach(([label, values, options], index) => {
    plotRow(full, label, values, { ...axes, height: 108, ...options,
      boxes: index === 0 ? [...earlierBoxes, ...originalBoxes] : options.boxes });
    if (clipped) plotRow(detail, label, values, { ...axes, height: 108, window: visible, ...options });
  });
  const original = full.querySelector("canvas");
  const originalChart = element("div", "encoding-original");
  const track = element("div", "overview-track encoding-window-track");
  const charts = element("div", "encoding-layout");
  charts.append(full);
  if (clipped) {
    original.replaceWith(originalChart);
    originalChart.append(original, track);
    charts.append(detail);
    bindTimeWindow(track, source, panel, detail, visible);
  }

  const words = element("div", "encoding-words");
  words.append(matchDictionary(round, event?.template));
  const summary = element("div", "encoding-step");
  if (event) {
    stageValue(view, number(event.score), "本步匹配");
    const word = element("div", "encoding-step-word");
    word.append(element("h3", "subheading", "本步使用的单词"),
      figure(`${templateName(event.template)} · ${pitchMultiplier(event.scale)}`,
        displayedVariant(variant), { height: 22 }));
    words.append(word);
    summary.append(facts([
      ["原谱位置", `第 ${event.box[0] + axes.tickOffset} tick · MIDI ${event.box[1] + song.pitchOrigin}`],
      ["匹配核范围", `${event.box[3] - event.box[1]} 音高 × ${event.box[2] - event.box[0]} tick`],
      ["停止阈值", number(data.threshold)],
    ]));
  } else {
    summary.append(element("p", "helper", events.length ? "初始状态 · 尚未放置单词。" : "本轮没有超过阈值的匹配。"));
  }
  const side = element("div", "encoding-side");
  const captures = element("section", "capture-panel");
  captureHistogram(captures, round, panel);
  side.append(ranking, captures);
  const dashboard = element("div", "encoding-dashboard");
  dashboard.append(charts, side);
  view.append(words, dashboard, summary);
  if (clipped) view.append(element("p", "helper", "点击或拖动全曲原谱上的窗口，可移动局部放大位置。"));
}

const relearningCache = new WeakMap();
const unblurredDensities = new WeakMap();

function relearningWords(round) {
  if (relearningCache.has(round)) return relearningCache.get(round);
  const words = round.dictionary.map((prototype, id) => ({
    id, prototype, initial: null, merges: [], notes: [], result: null,
  }));
  for (const event of round.density ?? []) {
    const word = words[event.template];
    if (event.absorbed === undefined) word.initial = event;
    else word.merges.push(event);
  }
  for (const item of round.learning ?? []) {
    const word = words[item.template];
    if (item.note) word.notes.push(item);
    else word.result = item;
  }
  const recorded = words.some((word) => word.initial || word.notes.length || word.result);
  const result = recorded ? words.filter((word) => word.prototype || word.initial?.count || word.result) : [];
  relearningCache.set(round, result);
  return result;
}

function wordRow(view, word, status) {
  const row = element("section", "relearning-word");
  const header = element("div", "relearning-heading");
  header.append(element("h3", "", templateName(word.id)), element("span", "", status));
  row.append(header);
  view.append(row);
  return row;
}

function sharedHeat(...packets) {
  return {
    heat: true,
    heatBounds: [0, Math.max(...packets.map((packet) => packet[3]))],
    domain: [0, 1].map((axis) => Math.max(...packets.map((packet) => packet[axis]))),
  };
}

function learningDensityData(round) {
  let averages = unblurredDensities.get(round);
  if (!averages) {
    const groups = capturesByWord(round);
    for (const { template, absorbed } of round.density ?? []) {
      if (absorbed !== undefined) groups[template] = groups[template].concat(groups[absorbed]);
    }
    averages = { groups, values: new Map() };
    unblurredDensities.set(round, averages);
  }
  return averages;
}

function unblurredDensity(round, word, density) {
  if (!density) return null;
  const averages = learningDensityData(round);
  if (averages.values.has(word.id)) return averages.values.get(word.id);
  const captures = averages.groups[word.id];
  const count = word.merges.at(-1)?.count ?? word.initial?.count;
  if (!captures.length || (count != null && count !== captures.length) || captures.some(({ restored }) => !restored)) return null;
  const [width, height] = density;
  const values = new Float32Array(width * height);
  for (const { restored } of captures) {
    const piece = matrix(restored);
    if (piece.width > width || piece.height > height) return null;
    accumulate(values, piece, [0, 0, width]);
  }
  let high = 0;
  for (let index = 0; index < values.length; index++) {
    values[index] /= captures.length;
    high = Math.max(high, values[index]);
  }
  const average = { width, height, low: 0, high, values };
  averages.values.set(word.id, average);
  return average;
}

function learningFrames(round) {
  const words = relearningWords(round).filter((word) => word.notes.length || word.result);
  return words.flatMap((word, index) => {
    const context = { word, index, wordCount: words.length };
    const frames = [context, ...word.notes.map((note) => ({ ...context, note }))];
    if (word.result) frames.push({ ...context, note: word.notes.at(-1), finished: true });
    return frames;
  });
}

function learningCaptures(row, word, captures) {
  row.append(element("p", "relearning-capture-caption", `裁切数据集 · ${captures.length} 块`));
  if (!captures.length) return;
  const strip = element("div", "relearning-captures");
  strip.tabIndex = 0;
  strip.setAttribute("role", "region");
  strip.setAttribute("aria-label", `${templateName(word.id)} 的裁切数据集`);
  captures.forEach((capture, index) => {
    const label = `第 ${index + 1} 个裁切块`;
    const thumbnail = plot(label, matrix(capture.crop), { height: 44 });
    thumbnail.title = label;
    strip.append(thumbnail);
  });
  row.append(strip);
  watchPlots(strip);
}

function viewLearning(panel, round, frame) {
  const view = panel.parts.view;
  const rows = panel.learningRows ??= [];
  if (!frame) {
    clearPlots(view);
    rows.length = 0;
    view.append(element("p", "stage-status", "本轮没有可回放的基元学习记录。"));
    return;
  }
  if (!rows.length) view.replaceChildren();
  const frames = new Map();
  for (let index = 0; index <= panel.step; index++) {
    const item = panel.items[index];
    frames.set(item.word, item);
  }
  const visible = [...frames.values()];
  const blur = showBlur();
  let index = 0;
  for (; index < visible.length; index++) {
    if (rows[index]?.word !== visible[index].word) break;
    updateLearningRow(rows[index], round, visible[index], blur);
  }
  for (const state of rows.splice(index)) {
    clearPlots(state.row);
    state.row.remove();
  }
  const { groups } = learningDensityData(round);
  for (const item of visible.slice(index)) {
    const row = wordRow(view, item.word, "");
    const status = row.querySelector(".relearning-heading span");
    learningCaptures(row, item.word, groups[item.word.id]);
    const plots = element("div", "figures relearning-plots learning-plots");
    row.append(plots);
    const state = { word: item.word, row, status, plots };
    updateLearningRow(state, round, item, blur);
    rows.push(state);
  }
}

function updateLearningRow(state, round, frame, blur) {
  if (state.frame === frame && state.blur === blur) return;
  state.frame = frame;
  state.blur = blur;
  const { word, note, finished } = frame;
  const options = { height: 126, axes: true };
  const density = note?.density ?? word.notes[0]?.density ?? word.merges.at(-1)?.matrix ?? word.initial?.matrix;
  const heat = { ...options, ...(density ? sharedHeat(density) : { heat: true }) };
  const rawDensity = blur ? null : unblurredDensity(round, word, density);
  state.status.textContent = finished ? `共添加 ${word.notes.length} 个基元 · ${word.result.result ? "已生成新原型" : "基元不足，释放位置"}`
    : note ? `已添加 ${note.count} 个基元` : "尚未添加基元";
  const focus = note && !finished ? [{
    box: [note.note[0], note.note[1], note.note[0] + 1, note.note[1] + 1], color: colors.match, lineWidth: 2,
  }] : [];
  const plots = [
    figure("本轮原型", word.prototype, options),
    rawDensity ? figure("裁切片段均值（模糊前）", rawDensity, { ...options, heat: true, boxes: focus })
      : figure("用于重学习的密度", density, { ...heat, boxes: focus }),
  ];
  if (finished) {
    plots.push(figure("新原型", word.result.result, options, word.result.result ? "起点与音高已归一化" : ""));
  } else if (note) {
    const [tick, pitch, duration] = note.note;
    plots.push(figure(blur ? "已添加基元的模糊核" : "已添加的基元", note.matrix,
      { ...options, blur: blurSettings("density"), boxes: focus },
      `本步位置 ${tick} tick · 音高行 ${pitch} · 延音 ${duration} 格`));
  }
  if (note) plots.push(figure(rawDensity ? "剩余密度（训练记录）" : "剩余密度", note.remaining, heat));
  clearPlots(state.plots);
  state.plots.append(...plots);
  watchPlots(state.plots);
}

function metricsChart(indices, height, rows) {
  const canvas = document.createElement("canvas");
  canvas.style.height = `${height}px`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", indices.map((index) => data.metricNames[index]).join("、") + `趋势，共 ${rows.length} 轮`);
  plotDrawers.set(canvas, () => {
    const width = canvas.clientWidth;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    const left = 47, right = width - 15, top = 12, bottom = height - 26;
    const scale = indices.length === 1 ? 100 : 5;
    let min = 0;
    let max = 1 / scale;
    for (const row of rows) {
      for (const index of indices) {
        if (row[index] == null) continue;
        min = Math.min(min, Math.floor(row[index] * scale) / scale);
        max = Math.max(max, Math.ceil(row[index] * scale) / scale);
      }
    }
    const last = rows.length - 1;
    const x = (index) => last === 0
      ? (left + right) / 2 : left + (right - left) * index / last;
    const y = (value) => top + (bottom - top) * (max - value) / (max - min);
    const styles = getComputedStyle(canvas);
    const line = styles.getPropertyValue("--line").trim();
    const muted = styles.getPropertyValue("--muted").trim();
    context.font = "10px Consolas, monospace";
    for (let tick = 0; tick <= 4; tick++) {
      const value = min + (max - min) * tick / 4;
      context.fillStyle = line;
      context.fillRect(left, y(value), right - left, 1);
      context.fillStyle = muted;
      context.textAlign = "right";
      context.fillText(value.toFixed(3), left - 5, y(value) + 4);
    }
    context.fillStyle = styles.getPropertyValue("--accent-light").trim();
    context.fillRect(x(last) - 4, top, 8, bottom - top);
    for (const index of indices) {
      context.strokeStyle = context.fillStyle = styles.getPropertyValue(`--metric-${index}`).trim();
      context.lineWidth = 1.7;
      context.beginPath();
      rows.forEach((row, round) => {
        if (row[index] == null) return;
        if (rows[round - 1]?.[index] == null) context.moveTo(x(round), y(row[index]));
        else context.lineTo(x(round), y(row[index]));
      });
      context.stroke();
      rows.forEach((row, round) => {
        if (row[index] == null) return;
        context.beginPath();
        context.arc(x(round), y(row[index]), round === last ? 4 : 2.7, 0, 2 * Math.PI);
        context.fill();
      });
    }
    context.fillStyle = muted;
    context.textAlign = "center";
    const step = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((right - left) / 35))));
    rows.forEach((_, index) => {
      if (index === last || (index % step === 0 && last - index >= step / 2)) {
        context.fillText(String(index + 1), x(index), height - 8);
      }
    });
  });
  return canvas;
}

function wordDimensions(packets, initial = [1, 1]) {
  let [ticks, pitches] = initial;
  for (const packet of packets) {
    if (!packet) continue;
    ticks = Math.max(ticks, packet[0]);
    pitches = Math.max(pitches, packet[1]);
  }
  return [ticks, pitches];
}

function iterationWords(round) {
  const learned = new Map(round.learning.filter(item => Object.hasOwn(item, "result"))
    .map(({ template, result }) => [template, result]));
  return {
    learned: learned.size > 0,
    packets: round.dictionary.map((packet, word) => learned.has(word) ? learned.get(word) : packet),
  };
}

function iterationState(round, index, song, wordDomain) {
  const column = element("article", "iteration-state");
  column.append(element("h3", "", `第 ${index + 1} 轮`));
  const score = element("section", "iteration-score-section");
  score.append(element("h4", "subheading", "拼图结果"));
  const raw = matrix(song.roll);
  const events = matchesFor(round);
  const { values, variants } = encodedThrough(round, song, events, events.length - 1);
  const results = events.map(event => {
    const [left, low] = event.box;
    const { width, height } = matrix(variants.get(variantName(event)).matrix);
    return { ...matchBox([left, low, left + width, low + height]), lineWidth: 1 };
  });
  const axes = { ...songAxes(song), height: 128 };
  const reconstructed = element("div", "iteration-score");
  reconstructed.append(
    element("p", "iteration-caption", `重构乐谱 · ${results.length} 个结果框`),
    plot("重构乐谱及结果方框", { ...raw, values }, { ...axes, boxes: results }),
  );
  score.append(reconstructed);

  const dictionary = element("section", "iteration-dictionary");
  dictionary.append(element("h4", "subheading", "字典状态"));
  const { learned, packets } = iterationWords(round);
  const words = element("div", "iteration-words");
  packets.forEach((packet, word) => {
    words.append(figure(templateName(word), packet, { height: 64, wordDomain }));
  });
  dictionary.append(element("p", "iteration-caption", learned ? "重学习后 · 原体" : "编码时 · 原体"), words);
  const groups = [...capturesByWord(round).entries()].sort((a, b) => b[1].length - a[1].length);
  const histogram = iterationHistogram(groups, round.dictionary, {
    title: "片段直方图", detailId: `iteration-capture-detail-${index + 1}`, scope: "全部曲目",
  });
  column.append(score, dictionary, histogram);
  return column;
}

function iterationAnnotations(song, packet) {
  const column = element("article", "iteration-state");
  column.append(element("h3", "", "标注结果"));
  const section = element("section", "iteration-score-section");
  section.append(element("h4", "subheading", "原始乐谱"));
  const instances = annotationItems(packet);
  const raw = matrix(song.roll);
  const axes = songAxes(song);
  const annotations = instances.length ? annotationOverlays(instances, packet.resolution, {
    resolution: beatResolution(), tickOrigin: axes.tickOffset, pitchOrigin: song.pitchOrigin,
  }, raw) : (song.boxes ?? []).map(box => ({ box, color: colors.capture, dashed: true, lineWidth: 1 }));
  const score = element("div", "iteration-score");
  score.append(
    element("p", "iteration-caption", annotations.length ? `${annotations.length} 个标注框` : "无标注"),
    plot("原始乐谱及标注方框", raw, { ...axes, height: 128, boxes: annotations }),
  );
  section.append(score);
  column.append(section);
  if (!instances.length) return column;

  const byCategory = new Map();
  for (const instance of instances) {
    if (!byCategory.has(instance.group)) byCategory.set(instance.group, { color: instance.color, fragments: [] });
    byCategory.get(instance.group).fragments.push({ crop: annotationThumbnail(instance, packet.resolution) });
  }
  const categories = [...byCategory.entries()].sort((a, b) => b[1].fragments.length - a[1].fragments.length);
  const nameFor = (index) => `类别 ${categories[index][0]}`;
  const originals = categories.map(([, { fragments }]) => fragments[0].crop);
  const dictionary = element("section", "iteration-dictionary");
  dictionary.append(element("h4", "subheading", "标注字典"), element("p", "iteration-caption", "每类显示首个标注片段"));
  const words = element("div", "iteration-words");
  originals.forEach((original, index) => {
    const item = figure(nameFor(index), original, { height: 64 });
    const swatch = element("span", "annotation-swatch");
    swatch.style.backgroundColor = categories[index][1].color;
    item.querySelector("figcaption").prepend(swatch);
    words.append(item);
  });
  dictionary.append(words);
  const groups = categories.map(([, { fragments }], index) => [index, fragments]);
  const histogram = iterationHistogram(groups, originals, {
    title: "标注片段直方图", detailId: "iteration-annotation-fragments", nameFor,
    groupColors: categories.map(([, { color }]) => color),
  });
  column.append(dictionary, histogram);
  return column;
}

function iterationHistogram(groups, dictionary, { title, detailId, scope, nameFor = templateName, groupColors }) {
  const section = element("section", "iteration-capture-section");
  section.append(element("h4", "subheading", title));
  const total = groups.reduce((sum, [, fragments]) => sum + fragments.length, 0);
  if (!total) {
    section.append(element("p", "iteration-caption", "暂无片段"));
    return section;
  }
  const stack = element("div", "iteration-captures");
  stack.tabIndex = 0;
  stack.setAttribute("role", "region");
  stack.setAttribute("aria-label", title);
  const detail = element("div", "iteration-capture-detail");
  detail.id = detailId;
  detail.hidden = true;
  let selected;
  const inspect = (word, captures, trigger) => {
    clearPlots(detail);
    selected?.setAttribute("aria-expanded", "false");
    if (selected === trigger) {
      selected = null;
      detail.hidden = true;
      return;
    }
    selected = trigger;
    selected.setAttribute("aria-expanded", "true");
    detail.hidden = false;
    const title = element("h5", "subheading", `${nameFor(word)} · ${captures.length} 个片段`);
    const gallery = element("div", "iteration-capture-gallery");
    gallery.tabIndex = 0;
    gallery.setAttribute("role", "region");
    gallery.setAttribute("aria-label", title.textContent);
    for (const [index, capture] of captures.entries()) {
      gallery.append(figure(`第 ${index + 1} 块`, capture.crop, { height: 54 }));
    }
    detail.append(title, gallery);
    watchPlots(detail);
  };
  const grid = captureBins(groups, dictionary, { inspect, nameFor, topDown: true });
  if (groupColors) {
    stack.classList.add("annotation-captures");
    for (const [index, bin] of [...grid.children].entries()) {
      bin.classList.add("annotation-capture-bin");
      bin.style.setProperty("--annotation-color", groupColors[index]);
    }
  }
  stack.append(grid);
  for (const trigger of stack.querySelectorAll(".capture-bin-trigger")) {
    trigger.setAttribute("aria-controls", detail.id);
  }
  section.append(element("p", "iteration-caption", `${scope ? `${scope} · ` : ""}${total} 个片段 · 点击分组查看`),
    stack, detail);
  return section;
}

const iterationDialog = get("iteration-dialog");
const iterationStates = get("iteration-states");
const iterationTrend = get("iteration-trend");
let comparedRecord, comparedSong, comparedAnnotationPacket;
const iterationAnnotationPackets = new WeakMap();
let iterationWordDomain = [1, 1];
let measuredRounds = 0;

function iterationAnnotationPacket(song) {
  if (sourceMode.value === "local" && localSource && localSource === sharedSource && song.id === localSource.name) {
    return inputAnnotations;
  }
  if (!iterationAnnotationPackets.has(song)) {
    iterationAnnotationPackets.set(song, null);
    trackAnnotations(song.id, data.track).then((packet) => {
      if (!packet) return;
      iterationAnnotationPackets.set(song, packet);
      if (currentSong() === song) refreshIterations();
    }).catch(() => {});
  }
  return iterationAnnotationPackets.get(song);
}

function refreshIterations() {
  if (!iterationDialog.open) return;
  const song = currentSong();
  if (comparedRecord !== data || comparedSong !== song) {
    clearPlots(iterationStates);
    comparedRecord = data;
    comparedSong = song;
    iterationWordDomain = [1, 1];
    measuredRounds = 0;
  }
  const [previousTicks, previousPitches] = iterationWordDomain;
  while (measuredRounds < data.rounds.length) {
    const { packets } = iterationWords(data.rounds[measuredRounds++]);
    const [ticks, pitches] = wordDimensions(packets, iterationWordDomain);
    iterationWordDomain[0] = ticks;
    iterationWordDomain[1] = pitches;
  }
  if (previousTicks !== iterationWordDomain[0] || previousPitches !== iterationWordDomain[1]) {
    for (const canvas of iterationStates.querySelectorAll(".iteration-words canvas")) plotDrawers.get(canvas)();
  }
  const count = song ? Math.min(state.round + 1, data.rounds.length) : 0;
  iterationStates.hidden = !count;
  let annotations = iterationStates.lastElementChild;
  const packet = count ? iterationAnnotationPacket(song) : null;
  if (count && (!annotations || packet !== comparedAnnotationPacket)) {
    const column = iterationAnnotations(song, packet);
    if (annotations) {
      clearPlots(annotations);
      annotations.replaceWith(column);
    } else iterationStates.append(column);
    annotations = column;
    comparedAnnotationPacket = packet;
    watchPlots(annotations);
  }
  while (iterationStates.childElementCount > count + 1) {
    const lastRound = annotations.previousElementSibling;
    clearPlots(lastRound);
    lastRound.remove();
  }
  const renderedRounds = Math.max(0, iterationStates.childElementCount - 1);
  for (let index = renderedRounds; index < count; index++) {
    const column = iterationState(data.rounds[index], index, song, iterationWordDomain);
    annotations.before(column);
    watchPlots(column);
  }
  const active = count ? iterationStates.children[state.round] : null;
  if (active) {
    for (const column of iterationStates.children) column.toggleAttribute("data-active", column === active);
    iterationStates.scrollLeft += active.getBoundingClientRect().left - iterationStates.getBoundingClientRect().left;
  }
  clearPlots(iterationTrend);
  if (!count) {
    iterationTrend.append(element("p", "iteration-caption", "暂无可对比的训练轮次。"));
    return;
  }
  iterationTrend.append(element("h3", "subheading", "指标曲线"));
  const rows = data.metrics.slice(0, count);
  if (!rows.length || !data.metricNames?.length) {
    iterationTrend.append(element("p", "iteration-caption", "暂无指标记录"));
    return;
  }
  const legend = element("div", "details-bar iteration-legend");
  for (const [id, name] of data.metricNames.entries()) {
    const value = rows.at(-1)[id];
    const label = element("strong", "", `${name} ${value == null ? "—" : number(value)}`);
    if (value == null) label.title = "此轮缺少计算该指标所需的逐音符标注";
    label.style.color = `var(--metric-${id})`;
    legend.append(label);
  }
  const chart = element("div", "metric-chart");
  const indices = data.metricNames.map((_, id) => id);
  const scores = indices.filter(id => data.metricNames[id] !== "RMSE");
  if (scores.length) chart.append(metricsChart(scores, 135, rows));
  const rmse = data.metricNames.indexOf("RMSE");
  if (rmse >= 0) chart.append(metricsChart([rmse], 105, rows));
  iterationTrend.append(legend, chart);
  watchPlots(iterationTrend);
}

function steps(key) {
  const round = currentRound();
  if (!round) return [];
  if (key === "trials") return trialFrames(round);
  if (key === "matches") return [null, ...matchesFor(round)];
  if (key === "learning") return learningFrames(round);
  return [];
}

function watchPlots(container) {
  for (const canvas of container.querySelectorAll("canvas")) {
    plotObserver.observe(canvas);
    plotSizer.observe(canvas);
  }
}

function clearPlots(container) {
  for (const canvas of container.querySelectorAll("canvas")) {
    plotObserver.unobserve(canvas);
    plotSizer.unobserve(canvas);
  }
  container.replaceChildren();
}

function render(panel) {
  const { key, parts, items } = panel;
  const round = currentRound();
  const song = currentSong();
  const item = items[panel.step];
  parts.value.replaceChildren();
  const progress = playbackProgress[key];
  if (progress) {
    const position = items.length ? progress.position(panel.step, items.length, item) : "暂无回放步骤";
    parts.position.value = position;
    parts.scrub.setAttribute("aria-valuetext", position);
  }
  parts.scrub.max = Math.max(0, items.length - 1);
  parts.scrub.value = panel.step;
  parts.scrub.disabled = parts.play.disabled = items.length <= 1;
  parts.back.disabled = panel.step === 0;
  parts.next.disabled = panel.step + 1 >= items.length;

  const { view } = parts;
  if (key === "learning" && round && song) {
    viewLearning(panel, round, item);
    return;
  }
  if (key === "learning" && panel.learningRows) panel.learningRows.length = 0;
  const matchScroll = key === "matches" ? new Map(
    [...view.querySelectorAll("[data-match-scroll]")].map((node) =>
      [node.dataset.matchScroll, { top: node.scrollTop, left: node.scrollLeft }]),
  ) : null;
  clearPlots(view);
  if (key === "input") viewInput(view, panel);
  else if (key === "similarity") viewSimilarity(view);
  else if (!round || !song) {
    view.append(element("p", "stage-status", "选择音轨后运行训练，可在这里查看结果。"));
  } else if (key === "trials") {
    stageValue(view, `${round.dictionary.filter(Boolean).length} / ${round.dictionary.length}`, "已填充");
    viewTrial(view, round, item);
  } else if (key === "variants") viewVariant(view, round, song, panel);
  else if (key === "matches") viewMatch(view, round, song, panel);
  watchPlots(view);
  if (matchScroll) {
    for (const node of view.querySelectorAll("[data-match-scroll]")) {
      const position = matchScroll.get(node.dataset.matchScroll);
      if (position) node.scrollTo(position);
    }
    const current = view.querySelector(".encoding-dictionary-word[aria-current]");
    if (current) {
      const list = current.parentElement;
      const item = current.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      list.scrollLeft += Math.min(0, item.left - viewport.left) + Math.max(0, item.right - viewport.right);
    }
  }
}

let playingPanel = null;

window.addEventListener("message", (event) => {
  if (event.source === window.parent && event.origin === window.location.origin &&
      event.data?.type === "musicword:deactivate") stop(playingPanel);
});

function syncPlay(panel) {
  panel.parts.play.innerHTML = icon(panel.timer ? "pause" : "play");
  panel.parts.play.setAttribute("aria-label", panel.timer ? "暂停" : "播放");
}

function stop(panel) {
  if (!panel?.timer) return;
  clearInterval(panel.timer);
  panel.timer = null;
  playingPanel = null;
  syncPlay(panel);
}

function followLearningWord(panel) {
  const row = panel.learningRows?.at(-1)?.row;
  if (!row) return;
  const word = row.getBoundingClientRect();
  const { transport } = panel.parts;
  const top = parseFloat(getComputedStyle(transport).top) + transport.offsetHeight + 8;
  const bottom = window.innerHeight - 8;
  if (top >= bottom) return;
  const offset = Math.min(word.top - top, Math.max(0, word.bottom - bottom));
  if (Math.abs(offset) >= 1) window.scrollBy({ top: offset, behavior: "instant" });
}

function setStep(panel, step, preserveCenter = false) {
  panel.step = Math.min(Math.max(0, step), Math.max(0, panel.items.length - 1));
  if (!preserveCenter) panel.center = null;
  render(panel);
  if (panel.key === "learning" && panel.timer) followLearningWord(panel);
}

function play(panel) {
  if (panel.timer) { stop(panel); return; }
  if (panel.items.length < 2) return;
  stop(playingPanel);
  if (panel.step === panel.items.length - 1) setStep(panel, 0);
  playingPanel = panel;
  panel.timer = setInterval(() => {
    setStep(panel, panel.step + 1);
    if (panel.step === panel.items.length - 1) stop(panel);
  }, 900 / Number(panel.parts.speed.value));
  syncPlay(panel);
  if (panel.key === "learning") followLearningWord(panel);
}

function createPanel([key, title, description]) {
  const section = get("stage-template").content.firstElementChild.cloneNode(true);
  if (key === "similarity") {
    const heading = element("h3", "similarity-heading");
    heading.dataset.part = "title";
    section.querySelector('[data-part="title"]').replaceWith(heading);
  }
  const parts = Object.fromEntries(
    [...section.querySelectorAll("[data-part]")].map((node) => [node.dataset.part, node]),
  );
  const panel = { key, section, parts, items: steps(key), step: 0, timer: null, center: null };

  section.id = `stage-${key}`;
  parts.title.id = `${section.id}-title`;
  section.setAttribute("aria-labelledby", parts.title.id);
  parts.title.textContent = title;
  parts.description.textContent = description;
  if (get(`formulas-${key}`)) parts.formulas.dataset.equations = key;
  if (key === "matches") {
    const captures = element("section", "capture-formulas");
    const equations = element("div", "formula-grid");
    equations.dataset.equations = "captures";
    captures.append(element("h3", "subheading", "裁切数据集公式"), equations);
    parts.view.after(captures);
  }
  if (key === "variants") {
    parts.responseDictionary = get("response-dictionary");
    parts.responseDialog = get("response-dictionary-dialog");
    parts.responseDialog.addEventListener("close", () => {
      parts.view.querySelector(".response-preview")?.focus({ preventScroll: true });
    });
  }
  const progress = playbackProgress[key];
  parts.transport.hidden = !progress;
  if (progress) {
    parts.scrub.id = `${section.id}-progress`;
    parts.progressLabel.id = `${parts.scrub.id}-label`;
    parts.progressLabel.htmlFor = parts.scrub.id;
    parts.progressLabel.textContent = progress.label;
    parts.progressDescription.id = `${parts.scrub.id}-description`;
    parts.progressDescription.textContent = progress.description;
    parts.transport.setAttribute("aria-labelledby", parts.progressLabel.id);
    parts.scrub.setAttribute("aria-describedby", parts.progressDescription.id);
    parts.position.htmlFor = parts.scrub.id;
  }
  parts.back.innerHTML = icon("back");
  parts.next.innerHTML = icon("next");
  syncPlay(panel);
  parts.back.addEventListener("click", () => { stop(panel); setStep(panel, panel.step - 1); });
  parts.next.addEventListener("click", () => { stop(panel); setStep(panel, panel.step + 1); });
  parts.play.addEventListener("click", () => play(panel));
  parts.scrub.addEventListener("input", () => { stop(panel); setStep(panel, Number(parts.scrub.value)); });
  parts.speed.addEventListener("change", () => { if (panel.timer) { stop(panel); play(panel); } });

  if (key === "similarity") get("stage-variants").append(section);
  else get("stage-metrics").before(section);
  return panel;
}

const panels = stages.map(createPanel);
for (const slot of document.querySelectorAll("[data-equations]")) {
  slot.append(get(`formulas-${slot.dataset.equations}`).content.cloneNode(true));
}
const topbar = document.querySelector(".topbar");
const stageSelect = get("stage-select");
const mobileStage = stageSelect.closest("label");
const stageToggle = get("stage-toggle");
const stageNav = get("stages");
const navigation = [...get("workspace").querySelectorAll(":scope > .playback-stage")].map(section => {
  const title = get(section.getAttribute("aria-labelledby"));
  const key = section.id.slice("stage-".length);
  const link = element("a", "stage-button");
  link.href = `#${section.id}`;
  link.append(element("span", "stage-label", title.textContent));
  stageNav.append(link);
  stageSelect.add(new Option(title.textContent, key));
  return { key, section, title, link };
});
stageToggle.addEventListener("click", () => {
  const expanded = stageNav.hidden;
  const label = expanded ? "收起训练流程" : "展开训练流程";
  stageNav.hidden = !expanded;
  stageToggle.setAttribute("aria-expanded", String(expanded));
  stageToggle.setAttribute("aria-label", label);
  stageToggle.title = label;
  onScroll();
});

function syncLocation() {
  const boundary = Math.max(topbar.getBoundingClientRect().bottom, mobileStage.getBoundingClientRect().bottom);
  let active = navigation[0];
  for (const item of navigation) {
    if (item.title.getBoundingClientRect().top <= boundary + 60) active = item;
  }
  const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
  if (atBottom) active = navigation.at(-1);
  state.activeStage = stageSelect.value = active.key;
  for (const item of navigation) {
    if (item === active) item.link.setAttribute("aria-current", "location");
    else item.link.removeAttribute("aria-current");
  }
  if (playingPanel) {
    const rect = playingPanel.section.getBoundingClientRect();
    if (rect.bottom <= boundary || rect.top >= window.innerHeight) stop(playingPanel);
  }
}

let scrollFrame = 0;
function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; syncLocation(); });
}

function changeRun(key, value, preservePosition = false) {
  stop(playingPanel);
  state[key] = value;
  syncRoundTimelines();
  const round = currentRound();
  const dictionary = byStage("trials");
  clearPlots(dictionary.parts.context);
  if (round) {
    viewDictionary(dictionary.parts.context, round);
    watchPlots(dictionary.parts.context);
  }
  const { responseDictionary, responseDialog } = byStage("variants").parts;
  clearPlots(responseDictionary);
  if (!round?.variants[selectedVariant]?.responses[state.song]) {
    const first = round?.variants.findIndex((item) => item.responses[state.song]) ?? -1;
    selectedVariant = first === -1 ? null : first;
  }
  if (responseDialog.open) {
    if (round?.dictionary.some(Boolean)) viewResponseDictionary(responseDictionary, round);
    else responseDialog.close();
  }
  for (const panel of panels) {
    panel.items = steps(panel.key);
    if (panel.key === "matches") {
      panel.matches = panel.items.slice(1);
      panel.initialRanking = round?.variants.flatMap((item) => {
        const response = item.responses[state.song];
        return response ? [[item.template, item.scale, response.peak]] : [];
      }).sort((a, b) => b[2] - a[2]) ?? [];
      panel.responseRange = rankingRange(panel.initialRanking, panel.matches);
    }
    setStep(panel, preservePosition ? panel.step : 0, preservePosition);
  }
  onScroll();
  refreshIterations();
  updateSharedScore();
}

stageSelect.addEventListener("change", () => {
  const { section } = navigation.find(({ key }) => key === stageSelect.value);
  if (location.hash === `#${section.id}`) section.scrollIntoView();
  else location.hash = section.id;
});
const byStage = (key) => panels.find((panel) => panel.key === key);
const renderStage = (key) => render(byStage(key));
const status = element("p", "helper live-status");
status.setAttribute("role", "status");
const provenance = element("p", "helper run-info");
const form = element("form", "train-actions");
form.id = "training-settings";
form.noValidate = true;
const sourceMode = element("select", "");
sourceMode.id = "source-mode";
const songSelect = element("select", "");
songSelect.id = "song";
const trackSelect = element("select", "");
trackSelect.id = "track";
const upload = element("input", "file-input");
upload.id = "midi-file";
upload.type = "file";
upload.accept = previewAudio.accept;
const sourceRow = element("div", "control-strip source-controls");
const inputAnnotationRow = element("div", "control-strip");
const inputAnnotationGroup = element("div", "annotation-options");
inputAnnotationGroup.id = "input-annotation-group";
inputAnnotationGroup.setAttribute("role", "group");
inputAnnotationGroup.setAttribute("aria-label", "标注类别");
let activeAnnotationGroup = "";
const songLabel = field("曲目", songSelect, "切换 POP909 曲目会载入新乐谱并重新训练。");
const fileLabel = field("导入乐谱", upload, "支持 MIDI、MusicXML 和压缩 MusicXML。导入后可选择音轨。");
const sourceLabel = field("来源", sourceMode, "选择从 POP909 曲库读取，或导入本地 MIDI。");
const trainButton = button("运行训练", "action-button primary");
const cancelButton = button("取消训练", "action-button cancel-training");
cancelButton.hidden = true;
trainButton.type = "submit";
let localSource = null;
let sourceTracks = [];
let sharedApi, sharedControls, sharedReference, sharedSource, midiPicker;
let sourceRequest = null;
let inputAnnotationRequest = null;
let inputAnnotations = null;
let sourceReady = false;
let live = false;
let parametersEdited = false;
const emptyData = { rounds: [], songs: [], metrics: [] };
const previewKeys = ["resolution", "height", "scales", "blur", "sigma"];
const exampleKeys = ["blur", "sigma", "scales"];
const previewJob = { run: updatePreview, timer: null, request: null };
const exampleJob = { run: computeExamples, timer: null, request: null };
const trainingJob = { run: runTraining, timer: null, request: null };
let trainingRun = null;

function field(label, input, description) {
  const wrapper = element("div", "control-field");
  const caption = element("label", "parameter-label", label);
  caption.htmlFor = input.id;
  caption.id = `${input.id}-label`;
  const help = element("span", "parameter-help", description);
  help.id = `${input.id}-help`;
  input.setAttribute("aria-describedby", help.id);
  wrapper.append(caption, input, help);
  return wrapper;
}

function button(text, className = "action-button") {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function parameterInput(key, value, min, max, step = 1, id = key) {
  const input = element("input", "");
  input.id = id;
  input.name = key;
  input.value = value;
  input.setAttribute("form", form.id);
  if (min !== undefined) {
    input.type = "number";
    input.min = min;
    if (max !== undefined) input.max = max;
    input.step = step;
  } else {
    input.type = "text";
    input.className = "scale-input";
  }
  input.required = true;
  input.classList.add("parameter-input");
  return input;
}

function parameter(key, label, description, value, min, max, step = 1, id = key) {
  const input = parameterInput(key, value, min, max, step, id);
  const wrapper = field(label, input, description);
  if (input.type !== "number" || !input.max || key === "seed") return wrapper;

  const slider = element("input", "parameter-slider");
  slider.type = "range";
  slider.min = input.min;
  slider.max = input.max;
  slider.step = input.step;
  slider.value = input.value;
  slider.setAttribute("aria-labelledby", `${id}-label`);
  slider.setAttribute("aria-describedby", `${id}-help`);
  slider.addEventListener("input", () => {
    input.value = slider.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.addEventListener("input", () => {
    if (input.validity.valid) slider.value = input.value;
  });
  wrapper.insertBefore(slider, input);
  return wrapper;
}

function pairedParameter(label, description, entries, sliderBounds) {
  const wrapper = element("div", "control-field paired-parameter");
  const caption = element("span", "parameter-label", label);
  caption.id = `${entries[0][0]}-pair-label`;
  const help = element("span", "parameter-help", description);
  help.id = `${entries[0][0]}-pair-help`;
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-labelledby", caption.id);
  const values = element("div", "paired-values");
  const inputs = entries.map(([key, name, value, min, max]) => {
    const field = element("label", "", name);
    const input = parameterInput(key, value, min, max);
    input.setAttribute("aria-describedby", help.id);
    field.append(input);
    values.append(field);
    return input;
  });
  wrapper.append(caption, values, help);
  if (!sliderBounds) return wrapper;

  const [min, max] = sliderBounds;
  const track = element("div", "range-pair");
  const sliders = entries.map(([, name, value]) => {
    const slider = element("input", "parameter-slider");
    slider.type = "range";
    slider.min = min;
    slider.max = max;
    slider.value = value;
    slider.setAttribute("aria-label", `${label} · ${name}`);
    slider.setAttribute("aria-describedby", help.id);
    track.append(slider);
    return slider;
  });

  const updateTrack = () => {
    track.style.setProperty("--range-low", `${100 * (Number(sliders[0].value) - min) / (max - min)}%`);
    track.style.setProperty("--range-high", `${100 * (Number(sliders[1].value) - min) / (max - min)}%`);
  };
  for (const [index, slider] of sliders.entries()) {
    const input = inputs[index];
    const constrain = (value) => index === 0 ? Math.min(value, Number(sliders[1].value))
      : Math.max(value, Number(sliders[0].value));
    slider.addEventListener("input", () => {
      input.value = slider.value = String(constrain(Number(slider.value)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.addEventListener("input", () => {
      if (!input.validity.valid) return;
      slider.value = input.value = String(constrain(Number(input.value)));
      updateTrack();
    });
  }
  track.addEventListener("pointerdown", (event) => {
    if (event.target !== track || event.button !== 0) return;
    const rect = track.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 7) / (rect.width - 14)));
    const value = Math.round(min + fraction * (max - min));
    const midpoint = (Number(sliders[0].value) + Number(sliders[1].value)) / 2;
    const thumb = sliders[value < midpoint ? 0 : 1];
    thumb.value = value;
    thumb.focus();
    thumb.dispatchEvent(new Event("input"));
  });
  updateTrack();
  wrapper.insertBefore(track, help);
  return wrapper;
}

function parameterPanel(name, strip) {
  const panel = element("fieldset", "parameter-group");
  const legend = element("legend", "");
  if (name) legend.append(element("span", "", name));
  const toggle = button("参数说明", "parameter-help-toggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const expanded = panel.classList.toggle("show-parameter-help");
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "收起说明" : "参数说明";
  });
  legend.append(toggle);
  panel.append(legend, strip);
  return panel;
}

function parameterGroup(stage, name, ...fields) {
  const strip = element("div", "control-strip parameter-grid");
  strip.append(...fields);
  byStage(stage).parts.controls.append(parameterPanel(name, strip));
}

function launchControls() {
  const kernelControls = get("kernel-controls");
  const kernelFields = [
    parameter("blur", "模糊核大小", "全局高斯模糊核的边长。设为 1 时关闭模糊。", 5, 1, 11, 2),
    parameter("sigma", "模糊标准差", "预览、去重、匹配和重学习共用的高斯标准差。", 1.25, 0.1, 5, 0.05),
  ];
  for (const control of kernelFields) {
    const help = control.querySelector(".parameter-help");
    help.classList.add("sr-only");
    control.title = help.textContent;
  }
  kernelControls.prepend(...kernelFields);
  refreshChoices(sourceMode, [["POP909", "pop"], ["本地 MIDI", "local"]]);
  sourceRow.append(sourceLabel, songLabel, fileLabel, field("音轨", trackSelect, "切换量化预览和训练所用的 MIDI 音轨。"),
    parameter("resolution", "TPB", "每拍刻度数（Ticks Per Beat）。越大，量化越细，同样长的乐谱占用的时间格越多。", 24, 4, 96));
  fileLabel.hidden = true;
  inputAnnotationRow.classList.add("annotation-controls");
  inputAnnotationRow.append(element("span", "parameter-label", "标注类别"), inputAnnotationGroup);
  inputAnnotationRow.hidden = true;
  byStage("input").parts.controls.append(parameterPanel("输入与量化", sourceRow), inputAnnotationRow, status, provenance);
  parameterGroup("trials", "候选生成与变体",
    parameter("words", "初始单词数", "首轮预留的字典槽位。调大可容纳更多单词，也会增加候选筛选和匹配开销。", 4, 1, 12),
    parameter("scales", "音高缩放倍率", "用逗号分隔倍率。1 保留原音程，小于 1 压缩间距，大于 1 拉开间距。每个倍率都参与匹配。", "1, 0.8, 1.2"),
    parameter("seed", "随机种子", "决定随机候选的生成序列。相同输入和参数下，固定种子可复现结果，换值可尝试另一组候选。", 37, 0, 4294967295),
    pairedParameter("初始单词形状", "随机候选的音高跨度与音符起点采样范围。",
      [["height", "音高（半音）", 10, 2, 32], ["width", "时间（格）", 20, 2, 96]]),
    pairedParameter("音符（基元）数上下限", "每个随机候选抽取的基元数范围。",
      [["noteMin", "下限", 5, 1, 20], ["noteMax", "上限", 9, 1, 20]], [1, 20]),
    pairedParameter("音符（基元）时长上下限", "随机采样的时长范围，单位为格。采样后减去该候选的最短时长。",
      [["durationMin", "下限", 1, 0, 96], ["duration", "上限", 19, 0, 96]], [0, 96]),
  );
  parameterGroup("trials", "去重与入选",
    parameter("attempts", "每个位置最多尝试", "每个空槽最多生成的候选数。调高有更多机会填上空槽，也可能让筛选耗时更长。", 200, 1, 500),
    parameter("similarity", "去重阈值", "候选与已有单词的相似度超过此值就淘汰。调低会淘汰更多相似候选。", 0.8, 0, 1, 0.01, "similarity-limit"),
    parameter("usefulness", "入选响应阈值", "单词在乐谱上的最高匹配分数达到此值才会入选字典。调高会筛掉更多弱响应单词。", 0.3, 0.05, 2, 0.01),
  );
  const metricField = field("相似度量", similarityMetric, "");
  metricField.classList.add("similarity-metric-field");
  const metricNote = metricField.querySelector(".parameter-help");
  metricNote.className = "helper similarity-metric-note";
  similarityMetric.disabled = true;
  similarityMetric.addEventListener("change", () => {
    metricNote.textContent = similarityNotes[similarityMetric.value] ?? "";
    renderStage("similarity");
  });
  const exampleStatus = element("p", "helper live-status");
  exampleStatus.id = "example-status";
  exampleStatus.setAttribute("role", "status");
  byStage("similarity").parts.controls.append(metricField, exampleStatus);
  parameterGroup("variants", "匹配响应",
    parameter("notePenalty", "每个基元的响应惩罚", "单词每含一个基元，匹配响应就扣除一次该分值。", 0.018, 0, 1, 0.001),
    parameter("learnedPenalty", "重学习单词额外惩罚", "对重学习单词的初始匹配分数额外扣除的固定值。调高后，这些单词更难入选字典。", 0.25, 0, 2, 0.01),
  );
  parameterGroup("matches", "编码与裁切",
    parameter("threshold", "编码停止阈值", "剩余最高匹配分数低于此值时停止编码。调高会更早停止，留下较强的匹配。", 0.2, 0.05, 2, 0.01),
    parameter("repulsion", "局部响应抑制", "每次匹配后，对受影响时间列重算响应时扣除的分值。调高会减少时间上重叠的后续匹配。", 0.6, 0, 2, 0.01),
    parameter("capturePitchMargin", "音高裁切扩展（半音）", "裁取重学习片段时，在匹配框高低两侧各多取的半音数。调大可纳入更多邻近音高。", 10, 0, 64),
    parameter("captureTimeMargin", "时间裁切扩展（tick）", "裁取重学习片段时，在匹配框前后各多取的时间格数。调大可纳入更多前后音符。", 10, 0, 64),
  );
  parameterGroup("learning", "密度参数",
    parameter("minimumCaptures", "最少匹配数过滤", "单词有足够的匹配片段才会进入密度计算。调高会筛掉出现次数较少的单词。", 4, 1, 999),
    parameter("merge", "密度合并阈值", "两个密度图的相似度超过此值才合并片段。调高会减少合并。", 0.8, 0, 1, 0.01, "merge-limit"),
  );
  parameterGroup("learning", "基元生成",
    parameter("spawnRatio", "基元与延音的响应比例", "乘以初始密度峰值，得到起音门槛。调高会筛掉较弱的起音，并抬高延音判定区间的上下限。", 0.5, 0.01, 1, 0.01),
    pairedParameter("重学习基元数上下限", "低于下限时释放字典槽位，达到上限时停止添加基元。",
      [["learnedMin", "下限", 3, 1, 32], ["learnedMax", "上限", 8, 1, 32]], [1, 32]),
  );
  const iteration = element("div", "control-strip parameter-grid");
  iteration.append(parameter("rounds", "初始训练轮数", "自动重算和运行训练时执行的轮数。续训可用加号或「运行 N 轮」。", 2, 1),
    parameter("growth", "字典满载时扩容单词数", "新一轮开始时，若上轮重学习填满字典，就新增这么多空槽。设为 0 时保持字典容量。", 3, 0, 12));
  get("iteration-settings").append(parameterPanel("", iteration));
  form.append(trainButton, cancelButton);
  get("training-actions").append(form);

  get("window-size").addEventListener("input", (event) => {
    const label = `${windowBeats()} 拍`;
    get("window-beats").value = label;
    event.target.setAttribute("aria-valuetext", label);
    for (const stage of ["input", "variants", "matches"]) renderStage(stage);
  });
  get("blurred").addEventListener("change", () => {
    const trials = byStage("trials").parts.context;
    const open = [...trials.querySelectorAll("details")].map(node => node.open);
    clearPlots(trials);
    const round = currentRound();
    if (round) {
      viewDictionary(trials, round);
      trials.querySelectorAll("details").forEach((node, index) => { node.open = open[index]; });
      watchPlots(trials);
      const { responseDictionary, responseDialog } = byStage("variants").parts;
      clearPlots(responseDictionary);
      if (responseDialog.open) viewResponseDictionary(responseDictionary, round);
    }
    for (const stage of ["input", "trials", "similarity", "variants", "matches", "learning"]) renderStage(stage);
  });
  sourceMode.addEventListener("change", () => loadSource());
  songSelect.addEventListener("change", () => { if (live) loadSource(); });
  trackSelect.addEventListener("change", () => {
    resetSource();
    sourceReady = true;
    schedule(trainingJob, 0);
    loadInputAnnotations();
    updatePreview();
  });
  previewAudio.attachImport(upload, async (file) => {
    sourceMode.value = "local";
    localSource = { name: file.name, file, encoded: null };
    await loadSource();
  }, (message) => { status.textContent = message; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sourceReady) schedule(trainingJob, 0);
  });
  document.addEventListener("input", (event) => {
    if (!live || !event.target.matches(".parameter-input")) return;
    parametersEdited = true;
    const key = event.target.name;
    if (exampleKeys.includes(key)) schedule(exampleJob);
    if (!sourceReady) return;
    if (previewKeys.includes(key)) schedule(previewJob);
    schedule(trainingJob);
  });
  cancelButton.addEventListener("click", () => {
    cancel(trainingJob);
    controlsState();
    setTrainingStatus("已取消本次训练。");
  });
}

const settings = () => Object.fromEntries(new FormData(form));

// Pseudocode uses mirrors, so each setting still has one canonical form control.
const algorithmControls = [];
const algorithms = {
  process: ["训练流程", "输入：量化乐谱 M；输出：字典、匹配记录、重构乐谱。", `D ← 空字典(槽位数 = {{words}})
rng ← 随机序列(种子 = {{seed}})
for r = 1 to {{rounds}}:  # 初始训练轮数
    if D 已满: D ← 扩容(D, 新增槽位 = {{growth}})
    D, V ← 初始化字典(D, M, rng)
    匹配, 重构 ← 拼图编码(M, V)
    指标 ← 评估(M, 匹配, 重构)
    片段集 ← 裁切并逆缩放(M, 匹配)
    D ← 字典重学习(片段集)
return D, 匹配, 重构, 指标`],
  input: ["乐谱量化", "输入：所选乐谱与音轨；输出：训练矩阵 M。", `notes ← 读取乐谱(当前曲目, 当前音轨)
TPB ← {{resolution}}  # 每拍时间格数
notes ← 量化(notes, TPB)
M ← 钢琴卷帘(notes, 起音 = 1, 延音 = 0.01)
G ← 高斯核(边长 = {{blur}}, 标准差 = {{sigma}})
return M, G  # 训练保留原谱；G 用于模板匹配与密度学习`],
  trials: ["初始化字典", "输入：字典 D、乐谱 M；输出：通过筛选的字典与变体 V。", `候选形状 ← (音高 = {{height}} 半音, 时间 = {{width}} 格)
基元数范围 ← [{{noteMin}}, {{noteMax}}]  # 含上下限
时长采样范围 ← [{{durationMin}}, {{duration}}]  # 含上下限，单位：格
V ← []
for 槽位 in D:
    if 槽位非空 且 最高响应 ≥ {{usefulness}}: 保留单词和变体; continue
    清空当前槽位
    repeat 最多 {{attempts}} 次:
        T ← 随机采样基元(候选形状, 基元数范围, 时长采样范围)
        T ← 起点、音高和时长分别减去各自最小值(T)
        if 最大去重 ZNCC(T, D) > {{similarity-limit}}: continue
        V_T ← 音高缩放变体(T, 倍率 = {{scales}})
        if 最高匹配响应(V_T, M) ≥ {{usefulness}}:
            D[槽位] ← T; 接纳 V_T; break
return D, V  # 已有单词同样按所设倍率生成变体`],
  variants: ["相似度量", "输入：单词变体 T、乐谱 M；输出：各位置的匹配响应 R。", `for T in 字典的音高缩放变体:
    σ ← {{sigma}}  # 随机单词
    if T 来自重学习: σ ← {{sigma:learned}}
    B ← 高斯模糊(T, 核边长 = {{blur}}, σ)
    Z ← sum(同尺寸高斯模糊(T) × T)
    惩罚 ← 基元数(T) × {{notePenalty}}
    if T 来自重学习: 惩罚 ← 惩罚 + {{learnedPenalty}}
    R_T ← 有效互相关(M, B) / Z − 惩罚
return R  # 编码使用此响应；下方样例可比较其他指标`],
  similarity: ["匹配样例", "输入：样例单词、乐谱片段；输出：所选指标的响应图。", `指标 ← {{similarity-metric}}
M_G ← 高斯模糊(乐谱片段, {{blur}}, {{sigma}})
for 倍率 in [{{scales}}]:
    T ← 高斯模糊(音高缩放(样例单词, 倍率))
    R ← 滑动窗口度量(M_G, T, 指标)
最佳匹配 ← 所有倍率与位置中的最优值(R)
显示响应图(R, 最佳匹配)  # RMSE 取最小误差；图中映射为相似度`],
  matches: ["拼图编码与裁切", "输入：原谱 M、变体响应 R；输出：匹配、重构与分组片段集。", `U ← copy(M); 重构 ← 0; 匹配 ← []
while 存在可用响应图:
    T, 位置, 分数 ← 全局最高响应(R)
    if 分数 < {{threshold}}: break
    U[匹配框] ← max(U[匹配框] − 模糊模板(T), 0)
    重构[原型位置] ← 重构[原型位置] + 原始模板(T)
    匹配 ← 追加(匹配, T, 位置)
    R[受影响时间列] ← 归一化互相关(U, 各模糊模板) − {{repulsion}}
for 命中 in 匹配:
    P ← 裁切原谱(M, 命中框,
        音高两侧扩展 = {{capturePitchMargin}} 半音, 前后扩展 = {{captureTimeMargin}} 格)
    if P 含起音: 按命中单词分组追加(逆音高缩放(P, 命中倍率))
return 匹配, 重构, 片段集`],
  learning: ["字典重学习", "输入：按单词分组的片段集；输出：下一轮使用的字典 D。", `for 单词, 片段 in 片段集:
    if count(片段) < {{minimumCaptures}}: 释放槽位; continue
    H ← 高斯模糊(对齐补零后的片段均值, {{blur:density}}, {{sigma:density}})
    for 已保留密度 in 密度集:
        if 最大 ZNCC(已保留密度, H) > {{merge-limit}}:
            合并片段并移除已保留密度
    密度集[单词] ← 重新计算合并后的模糊均值
D ← 空字典(保留原槽位数)
for 单词, H in 密度集:
    peak ← max(H); U ← H; notes ← []
    τ ← peak × {{spawnRatio}}
    repeat 最多 {{learnedMax}} 次:
        p, t ← argmax(U)
        if U[p, t] < τ 或 peak ≤ 0: break
        d ← 起音后连续满足 0.01 × τ < U[p, t + Δt] < τ 的格数
        notes ← 追加(notes, 基元(p, t, d))
        U ← H − 高斯模糊(绘制全部 notes)
    D[单词] ← 归一化原型(notes) if count(notes) ≥ {{learnedMin}} else 空
return D`],
  metrics: ["匹配度评估", "输入：人工标注（如有）、预测匹配与重构；输出：每轮指标。", `RMSE ← sqrt(mean((重构 − 原谱)²))
if 没有人工标注: return RMSE
预测框 ← 从匹配记录提取片段边界与单词类别
IoU ← 最大权一对一配对后的平均交并比(人工标注框, 预测框)
真实类别, 预测类别 ← 比较音符起点处的标注类别与预测单词
ARI, 同质性, 完整性, V值 ← 聚类指标(真实类别, 预测类别)
return IoU, ARI, 同质性, 完整性, V值, RMSE`],
};

function syncAlgorithmControls() {
  for (const { source, input, slider, blurKind } of algorithmControls) {
    // Do not interrupt partial numeric input or move the text caret while typing.
    if (document.activeElement !== input) input.value = source.value;
    input.disabled = source.disabled;
    input.placeholder = source.placeholder || "";
    if (!live && data.config && ["blur", "sigma"].includes(source.name)) {
      input.value = blurSettings(blurKind)[source.name === "blur" ? 0 : 1];
    }
    input.setAttribute("aria-invalid", String(!source.validity.valid));
    if (slider) {
      if (input.validity.valid && input.value !== "") slider.value = input.value;
      slider.disabled = source.disabled;
      slider.hidden = source.disabled;
      slider.setAttribute("aria-valuetext", input.value || "未填写");
    }
  }
}

function algorithmControl(reference) {
  const [id, blurKind = "random"] = reference.split(":");
  const source = get(id);
  const input = source.cloneNode(true);
  const groupLabel = source.closest(".paired-parameter")?.querySelector(".parameter-label")?.textContent;
  const label = [groupLabel, source.labels?.[0]?.textContent.trim() || source.getAttribute("aria-label") || id].filter(Boolean).join(" · ");
  const help = get(source.getAttribute("aria-describedby"))?.textContent || "";
  input.removeAttribute("id");
  input.removeAttribute("name");
  input.removeAttribute("required");
  input.removeAttribute("aria-describedby");
  input.setAttribute("form", "algorithm-display");
  input.className = "algorithm-input";
  input.setAttribute("aria-label", label);
  input.title = [label, help].filter(Boolean).join("：");
  if (source.type === "text") input.classList.add("algorithm-input-wide");
  input.addEventListener(source.tagName === "SELECT" ? "change" : "input", () => {
    source.value = input.value;
    source.dispatchEvent(new Event(source.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    if (input.value !== source.value) input.value = source.value;
    syncAlgorithmControls();
  });
  // Options are populated asynchronously for the example metric selector.
  new MutationObserver(() => {
    if (source.tagName === "SELECT") input.replaceChildren(...[...source.options].map(option => option.cloneNode(true)));
    syncAlgorithmControls();
  }).observe(source, { attributes: true, childList: true, subtree: true });
  let slider;
  // Small bounded ranges suit dragging; seeds, large counts and lists stay typed.
  if (source.type === "number" && source.max && Number(source.max) <= 100) {
    slider = element("input", "algorithm-slider");
    slider.type = "range";
    slider.min = source.min;
    slider.max = source.max;
    slider.step = source.step;
    slider.value = source.value;
    slider.setAttribute("form", "algorithm-display");
    slider.setAttribute("aria-label", `${label} · 滑动调节`);
    slider.title = input.title;
    slider.addEventListener("input", () => {
      input.value = slider.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  algorithmControls.push({ source, input, slider, blurKind });
  if (!slider) return input;
  const pair = element("span", "algorithm-parameter");
  pair.append(slider, input);
  return pair;
}

function launchAlgorithms() {
  for (const [key, [title, description, code]] of Object.entries(algorithms)) {
    const section = get(`stage-${key}`);
    const algorithm = element("section", "algorithm");
    algorithm.setAttribute("aria-label", `${title}伪代码`);
    const header = element("div", "algorithm-heading");
    header.append(element("h3", "", "伪代码"), element("span", "algorithm-mode", "参数与训练设置同步"));
    const lines = element("ol", "algorithm-lines");
    for (const text of code.split("\n")) {
      const line = element("li", "algorithm-line");
      const content = element("code", "");
      const [statement, comment] = text.split("  # ");
      for (const part of statement.split(/(\{\{[^}]+\}\})/)) {
        if (part.startsWith("{{")) content.append(algorithmControl(part.slice(2, -2)));
        else {
          for (const token of part.split(/\b(for|in|to|if|else|repeat|while|return|continue|break)\b/g)) {
            content.append(/^(for|in|to|if|else|repeat|while|return|continue|break)$/.test(token)
              ? element("b", "algorithm-keyword", token) : document.createTextNode(token));
          }
        }
      }
      if (comment) content.append(element("span", "algorithm-comment", `  # ${comment}`));
      line.append(content);
      lines.append(line);
    }
    algorithm.append(header, element("p", "algorithm-description", description), lines);
    const controls = panels.find(panel => panel.key === key)?.parts.controls;
    if (controls) {
      const groups = [...controls.querySelectorAll(":scope > .parameter-group")];
      if (groups.length && key !== "input") {
        const details = element("details", "algorithm-settings");
        details.append(element("summary", "", "参数滑块与说明"), ...groups);
        controls.prepend(details);
      }
      controls.prepend(algorithm);
    } else section.querySelector(".stage-heading").after(algorithm);
  }
  document.addEventListener("input", event => {
    if (event.target.matches(".parameter-input")) syncAlgorithmControls();
  });
  similarityMetric.addEventListener("change", syncAlgorithmControls);
  syncAlgorithmControls();
}

function settingsFor(...keys) {
  const snapshot = settings();
  return Object.fromEntries(keys.map((key) => [key, snapshot[key]]));
}

function cancel(job) {
  clearTimeout(job.timer);
  job.timer = null;
  job.request?.abort();
  job.request = null;
}

function setTrainingStatus(message) {
  status.textContent = message;
  get("iteration-status").textContent = message;
}

function schedule(job, delay = 180) {
  cancel(job);
  job.timer = setTimeout(() => {
    job.timer = null;
    void job.run();
  }, delay);
  if (job === trainingJob) {
    setTrainingStatus("正在应用参数…");
    controlsState();
  }
}

function finish(job, request) {
  if (job.request === request) job.request = null;
}

function trainingPending() {
  return Boolean(trainingJob.timer || trainingJob.request);
}

function controlsState() {
  const running = trainingPending();
  trainButton.disabled = !sourceReady || running;
  cancelButton.hidden = !running;
  trainButton.textContent = running ? "正在训练…" : "运行训练";
  syncRoundActions();
}

async function api(action, parameters, signal) {
  const response = await fetch(new URL("workbench-api", document.baseURI), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...parameters }), signal,
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("本地计算服务不可用。"); }
  if (!response.ok || payload.error) throw new Error(payload.error || "本地计算失败。");
  return payload.result;
}

const roundTimelines = [get("round"), get("iteration-steps")].map(strip => ({
  strip, addButton: strip.querySelector(".round-add"),
}));
const iterationNext = get("iteration-next");
const openRoundBatch = get("open-round-batch");
const roundBatch = get("round-batch");
const roundBatchCount = get("round-batch-count");
const roundBatchButton = roundBatch.querySelector("button");

function canContinue() {
  return live && data.rounds.length > 0;
}

function openIterations() {
  if (iterationDialog.open) return;
  const iterationStatus = get("iteration-status");
  if (!sourceReady && !canContinue()) {
    iterationStatus.textContent = form.hidden ? "离线回放" : "在「乐谱量化」选择音轨后即可训练。";
  } else if (!iterationStatus.textContent && !trainingRun && data.rounds.length) {
    iterationStatus.textContent = "当前为保存的回放。可从最后一轮继续训练。";
  }
  iterationDialog.showModal();
  syncRoundTimelines();
  refreshIterations();
}

function syncRoundActions() {
  get("iteration-prev").disabled = !data.rounds.length || state.round === 0;
  iterationNext.disabled = state.round + 1 >= data.rounds.length;
  const canAddRound = canContinue() && !trainingPending();
  for (const { addButton } of roundTimelines) {
    addButton.hidden = !live;
    addButton.disabled = !canAddRound;
  }
  const canRunBatch = live && (canContinue() || sourceReady) && !trainingPending();
  openRoundBatch.hidden = roundBatch.hidden = !live;
  openRoundBatch.disabled = roundBatchCount.disabled = !canRunBatch;
  roundBatchButton.disabled = !canRunBatch || !Number.isSafeInteger(roundBatchCount.valueAsNumber) ||
    !roundBatchCount.validity.valid;
}

function syncRoundTimelines() {
  syncRoundActions();
  for (const { strip, addButton } of roundTimelines) {
    let selected;
    for (const item of strip.querySelectorAll("[data-round]")) {
      const index = Number(item.dataset.round);
      item.setAttribute("aria-pressed", String(index === state.round));
      item.toggleAttribute("data-reached", index <= state.round);
      if (index === state.round) selected = item;
    }
    if (!selected) continue;
    const frame = strip.getBoundingClientRect();
    const dot = selected.getBoundingClientRect();
    const end = selected.nextElementSibling === addButton && !addButton.hidden
      ? addButton.getBoundingClientRect().right : dot.right;
    if (end > frame.right) strip.scrollLeft += end - frame.right;
    else if (dot.left < frame.left) strip.scrollLeft += dot.left - frame.left;
  }
}

get("open-iterations").addEventListener("click", () => {
  const latest = data.rounds.length - 1;
  if (latest >= 0 && latest !== state.round) changeRun("round", latest);
  openIterations();
});
openRoundBatch.addEventListener("click", () => {
  openIterations();
  roundBatchCount.focus();
});
roundBatchCount.addEventListener("input", syncRoundActions);
roundBatch.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!roundBatchButton.disabled) void runTraining(canContinue(), roundBatchCount.valueAsNumber);
});
get("iteration-prev").addEventListener("click", () => changeRun("round", state.round - 1));
iterationNext.addEventListener("click", () => changeRun("round", state.round + 1));
for (const { addButton } of roundTimelines) {
  addButton.addEventListener("click", () => {
    if (!canContinue() || trainingPending()) return;
    void runTraining(true);
    openIterations();
  });
}
iterationDialog.addEventListener("close", () => {
  if (iterationDialog.open) return;
  clearPlots(iterationStates);
  clearPlots(iterationTrend);
});

function updateData(record, preservePosition = false) {
  data = record;
  const blurNote = get("blur-record-note");
  const config = record.config;
  const kinds = ["learned", "reference", "density"];
  const [size, sigma] = blurSettings();
  blurNote.hidden = !config || kinds.every(kind => {
    const [stageSize, stageSigma] = blurSettings(kind);
    return stageSize === size && stageSigma === sigma;
  });
  blurNote.title = blurNote.hidden ? "" : [["预览与候选", "random"], ["重学习单词匹配", "learned"],
    ["去重", "reference"], ["密度重学习", "density"]].map(([label, kind]) => {
    const [stageSize, stageSigma] = blurSettings(kind);
    return `${label} ${stageSize}×${stageSize} / σ ${stageSigma}`;
  }).join("\n");
  const active = preservePosition ? Math.min(state.round, Math.max(0, data.rounds.length - 1)) : 0;
  for (const { strip, addButton } of roundTimelines) {
    if (strip.childElementCount > 1 && strip.querySelectorAll("[data-round]").length === data.rounds.length) continue;
    const focusedRound = strip.contains(document.activeElement) && document.activeElement !== addButton;
    const items = document.createDocumentFragment();
    for (const index of data.rounds.keys()) {
      const item = button(String(index + 1), "round-step");
      item.dataset.round = index;
      item.setAttribute("aria-label", `第 ${index + 1} 轮`);
      if (strip.id === "round") item.setAttribute("aria-haspopup", "dialog");
      item.addEventListener("click", () => {
        changeRun("round", index);
        if (strip.id === "round") openIterations();
      });
      items.append(item);
    }
    if (!data.rounds.length) items.append(element("span", "round-empty", "未训练"));
    strip.replaceChildren(items, addButton);
    if (focusedRound) strip.querySelectorAll("[data-round]")[active]?.focus({ preventScroll: true });
  }
  provenance.textContent = data.songs.length
    ? `当前记录 · ${data.songs[state.song]?.id ?? data.songs[0].id} · 音轨 ${data.track} · 种子 ${data.seed}` : "暂无训练记录";
  changeRun("round", active, preservePosition);
}

function annotationItems(packet) {
  const versions = packet?.versions;
  const version = versions?.dictionary?.instances?.length ? versions.dictionary : versions?.csv;
  if (!version) return [];
  return groupedAnnotations(version).instances;
}

function inputAnnotationOverlay(preview, raw) {
  if (!inputAnnotations) return null;
  const instances = annotationItems(inputAnnotations)
    .filter(({ group }) => !activeAnnotationGroup || group === activeAnnotationGroup);
  return annotationOverlays(instances, inputAnnotations.resolution, preview, raw);
}

function annotationOverlays(instances, resolution, preview, raw) {
  const ratio = preview.resolution / resolution;
  function quantize(tick) {
    const grid = tick * ratio;
    const left = Math.floor(grid);
    return grid - left === 0.5 ? left + left % 2 : Math.round(grid);
  }
  function box(start, end, low, high) {
    const left = quantize(start) - preview.tickOrigin;
    const right = Math.max(left + 1, quantize(end) - preview.tickOrigin);
    return [left, low - preview.pitchOrigin, right, high - preview.pitchOrigin];
  }
  return instances
    .map((item) => ({ box: box(item.start, item.end, item.low, item.high), color: item.color }))
    .filter(({ box: [left, low, right, high] }) =>
      right > 0 && left < raw.width && high > 0 && low < raw.height);
}

function annotationThumbnail({ notes, low, high, start, end }, resolution) {
  const scale = Math.min(24 / resolution, 96 / Math.max(1, end - start));
  const width = Math.max(1, Math.ceil((end - start) * scale) + 1);
  const height = high - low;
  const values = new Float32Array(width * height);
  for (const [pitch, onset, release] of notes) {
    const row = (pitch - low) * width;
    values.fill(0.42, row + Math.floor((onset - start) * scale),
      row + Math.ceil((release - start) * scale));
  }
  for (const [pitch, onset] of notes) {
    values[(pitch - low) * width + Math.floor((onset - start) * scale)] = 1;
  }
  return { width, height, values };
}

function showInputAnnotationGroups() {
  const representatives = new Map();
  for (const item of annotationItems(inputAnnotations)) {
    if (!representatives.has(item.group)) representatives.set(item.group, item);
  }
  const options = [...representatives.values()].sort((a, b) =>
    a.group.localeCompare(b.group, "zh-CN", { numeric: true }));
  inputAnnotationRow.hidden = !options.length;
  for (const item of [null, ...options]) {
    const choice = button(item ? String(item.group) : "全部类别", "annotation-option");
    choice.dataset.group = item?.group ?? "";
    choice.setAttribute("aria-pressed", String(!item));
    if (item) {
      const span = item.end - item.start;
      const scale = Math.min(24 / inputAnnotations.resolution, 96 / Math.max(1, span));
      const image = plot(`类别 ${item.group} 的第一个实例`, annotationThumbnail(item, inputAnnotations.resolution), {
        height: 34, previewPitch: item.low, previewResolution: inputAnnotations.resolution * scale, pointerOnly: true,
      });
      image.setAttribute("aria-hidden", "true");
      choice.prepend(image);
    }
    choice.addEventListener("click", () => {
      activeAnnotationGroup = choice.dataset.group;
      for (const option of inputAnnotationGroup.children) {
        option.setAttribute("aria-pressed", String(option === choice));
      }
      renderStage("input");
    });
    inputAnnotationGroup.append(choice);
  }
  watchPlots(inputAnnotationGroup);
  renderStage("input");
}

function clearInputAnnotations() {
  inputAnnotationRequest?.abort();
  inputAnnotations = null;
  activeAnnotationGroup = "";
  clearPlots(inputAnnotationGroup);
  inputAnnotationRow.hidden = true;
}

function sharedAnnotationTrack() {
  if (!sharedReference || sourceMode.value !== "local" || localSource !== sharedSource) return null;
  const signature = sourceTracks.find((track) => track.id === Number(trackSelect.value))?.signature;
  return sharedApi.referenceTrack(sharedReference, signature);
}

function sharedAnnotationSelection() {
  const track = sharedAnnotationTrack();
  if (!sharedReference) return { track, segments: [], window: null };
  const layer = sharedControls.setTrackLayers(track);
  const segments = sharedApi.referenceSegments({ ...sharedReference, layer }, track);
  return { track, segments, window: sharedApi.referenceWindow(segments) };
}

function updateSharedScore() {
  if (!sharedReference || !sharedControls) return;
  if (sourceMode.value !== "local" || localSource !== sharedSource) {
    sharedControls.setScore("当前 MIDI 与所加载的标注不同。");
    return;
  }
  const { track, segments, window } = sharedAnnotationSelection();
  if (!window) {
    sharedControls.setScore("当前音轨在所选层没有可对齐的人工标注。");
    return;
  }
  const song = currentSong();
  const round = currentRound();
  if (!song || !round) {
    sharedControls.setScore("训练完成后显示人工标注对照结果。");
    return;
  }
  const scale = beatResolution() / sharedReference.document.timing.sourcePpq;
  const project = (note) => sharedApi.projectWindowNote(note, window, scale, 0);
  const notes = track.notes.map(project).filter(Boolean);
  const leftEdge = sharedApi.roundEven(window[0] * scale);
  const rightEdge = Math.max(leftEdge + 1, sharedApi.roundEven(window[1] * scale));
  const tickOffset = song.tickOrigin - song.timePad;
  const matches = round.matches.filter(({ song: index, box: [left, , right] }) =>
    index === state.song && left + tickOffset < rightEdge && right + tickOffset > leftEdge);
  const boxes = matches.map(({ box: [left, low, right, high] }) =>
    [Math.max(leftEdge, left + tickOffset), low + song.pitchOrigin,
      Math.min(rightEdge, right + tickOffset), high + song.pitchOrigin]);
  const groups = sharedApi.groupsInBoxes(notes, boxes);
  const predictions = matches.map((match, index) => ({
    categoryId: match.template, noteIds: groups[index], box: boxes[index],
  }));
  const counts = sharedApi.fragmentCounts(segments.map((segment) => segment.noteIds), groups);
  sharedControls.setScore(sharedApi.formatScores(counts, `第 ${state.round + 1} 轮`));
  const manual = segments.map((segment) => ({ ...segment, notes: segment.notes.map(project) }));
  sharedControls.compare([sharedApi.comparisonTrack(notes, manual, predictions)]);
}

async function initializeSharedAnnotations() {
  const toolbar = window.frameElement?.ownerDocument.getElementById("activebasis-source-slot");
  if (!toolbar) return;
  const mount = element("div", "");
  inputAnnotationRow.before(mount);
  try {
    const moduleUrl = new URL("/shared-annotations.mjs", location.origin).href;
    sharedApi = await import(/* @vite-ignore */ moduleUrl);
    sharedControls = sharedApi.mountAnnotationControls(mount, {
      toolbar,
      async onLoad(annotationDocument, file) {
        sourceMode.value = "local";
        upload.value = "";
        const source = { name: file.name, file, encoded: null, annotationDocument };
        localSource = source;
        await loadSource();
        if (source !== localSource || sourceMode.value !== "local" || !sourceReady) {
          throw new Error("无法加载标注所用的 MIDI。");
        }
        sharedSource = source;
      },
      onChange(reference) {
        sharedReference = reference;
        if (reference && sourceReady && localSource === sharedSource) {
          resetSource();
          sourceReady = true;
          schedule(trainingJob, 0);
          updatePreview();
        }
        loadInputAnnotations();
        updateSharedScore();
      },
    });
    midiPicker = sharedApi.mountMidiPicker(toolbar, {
      input: upload,
      onPreset(id) {
        songSelect.value = id;
        sourceMode.value = "pop";
        loadSource();
      },
    });
    const presets = element("optgroup", "");
    presets.label = "POP909 预置曲目";
    presets.append(...Array.from(songSelect.options, (option) => option.cloneNode(true)));
    midiPicker.setPresets([presets]);
    const download = upload.nextElementSibling;
    if (download?.matches(".mw-converted-midi")) toolbar.append(download);
    sourceLabel.hidden = songLabel.hidden = fileLabel.hidden = true;
    syncMidiPicker();
  } catch (error) {
    mount.textContent = error.message;
  }
}

async function loadInputAnnotations() {
  clearInputAnnotations();
  if (sourceMode.value === "local" && localSource === sharedSource && sharedReference) {
    const { segments } = sharedAnnotationSelection();
    const instances = segments.map(({ categoryId, color, notes }) => ({
      group: categoryId, color,
      notes: notes.map((note) => [note.midi, note.ticks, note.ticks + Math.max(1, note.durationTicks)]),
    }));
    inputAnnotations = { resolution: sharedReference.document.timing.sourcePpq, versions: { dictionary: { instances } } };
    showInputAnnotationGroups();
    updateSharedScore();
    refreshIterations();
    return;
  }
  if (sourceMode.value !== "pop") return;
  const song = live ? songSelect.value : currentSong()?.id;
  const track = live ? Number(trackSelect.value) : data.track;
  const controller = new AbortController();
  inputAnnotationRequest = controller;
  try {
    const result = await trackAnnotations(song, track, controller.signal);
    if (controller.signal.aborted || !result) return;
    inputAnnotations = result;
    showInputAnnotationGroups();
  } catch {
    if (!controller.signal.aborted) clearInputAnnotations();
  }
}

function resetSource(keepRecord = false) {
  sourceRequest?.abort();
  cancel(previewJob);
  cancel(trainingJob);
  trainingRun = null;
  clearInputAnnotations();
  get("iteration-status").textContent = "";
  sourceReady = false;
  inputPreview = null;
  byStage("input").center = null;
  if (!keepRecord) {
    state.song = 0;
    selectedVariant = null;
    updateData(emptyData);
  } else renderStage("input");
  controlsState();
}

function activeSource() {
  return sourceMode.value === "local" ? {
    midi: localSource.encoded, annotationRange: sharedAnnotationSelection().window,
  }
    : { id: songSelect.value };
}

function syncMidiPicker() {
  if (sourceMode.value === "local") {
    midiPicker?.setSelection("", localSource?.annotationDocument?.song.name ?? localSource?.name);
  } else {
    midiPicker?.setSelection(songSelect.value);
  }
}

async function loadSource(keepRecord = false) {
  sourceTracks = [];
  resetSource(keepRecord);
  const local = sourceMode.value === "local";
  songLabel.hidden = Boolean(midiPicker) || local;
  fileLabel.hidden = Boolean(midiPicker) || !local;
  syncMidiPicker();
  refreshChoices(trackSelect, []);
  if ((local && !localSource) || (!local && !songSelect.value)) {
    status.textContent = local ? "选择 MIDI 或 MusicXML 文件。" : "找不到 POP909。可导入本地乐谱。";
    return;
  }
  const controller = new AbortController();
  sourceRequest = controller;
  status.textContent = "正在读取音轨…";
  try {
    if (local && !localSource.encoded) {
      const uploadSource = localSource;
      if (uploadSource.file.size > 10 * 1024 * 1024) throw new Error("MIDI 文件超过 10 MB。");
      const bytes = new Uint8Array(await uploadSource.file.arrayBuffer());
      if (controller.signal.aborted) return;
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
      }
      uploadSource.encoded = btoa(chunks.join(""));
    }
    const tracks = await api("tracks", activeSource(), controller.signal);
    if (controller.signal.aborted) return;
    if (!tracks.length) throw new Error("此 MIDI 中没有带完整音符的音轨。");
    sourceTracks = tracks;
    const signatures = new Set(local && localSource.annotationDocument?.tracks
      .filter((track) => track.layers.some((layer) => layer.words.some((word) => !word.automatic)))
      .map((track) => track.signature) || []);
    const annotated = tracks.find((track) => signatures.has(track.signature))?.id;
    const preferred = keepRecord ? data.track : annotated ?? tracks.find((track) => track.id === 1)?.id;
    refreshChoices(trackSelect, tracks.map((track) =>
      [`${track.name || "音轨"} · ${track.id} · ${track.notes} 音符`, track.id]), preferred);
    sourceReady = true;
    if (keepRecord && Number(trackSelect.value) !== data.track) {
      state.song = 0;
      updateData(emptyData);
    }
    if (local && localSource.annotationDocument && localSource !== sharedSource) return;
    if (!data.rounds.length || parametersEdited) schedule(trainingJob, 0);
    await Promise.all([updatePreview(), loadInputAnnotations()]);
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = error.message;
  } finally {
    controlsState();
  }
}

async function updatePreview() {
  if (!sourceReady) return;
  const snapshot = settingsFor(...previewKeys);
  if (!previewKeys.every((key) => get(key).validity.valid)) return;
  cancel(previewJob);
  const controller = new AbortController();
  previewJob.request = controller;
  const previewOnly = !trainingPending();
  if (previewOnly) status.textContent = "正在量化音轨…";
  try {
    const result = await api("preview", {
      ...activeSource(), track: Number(trackSelect.value), settings: snapshot,
    }, controller.signal);
    if (controller.signal.aborted) return;
    inputPreview = result;
    renderStage("input");
    if (previewOnly && !trainingPending()) status.textContent = "量化预览已更新。";
  } catch (error) {
    if (!controller.signal.aborted && previewOnly && !trainingPending()) status.textContent = error.message;
  } finally {
    finish(previewJob, controller);
  }
}

function setExamples(examples) {
  similarityExamples = examples;
  const supported = similarityMetrics.filter(([, metric]) => examples.some((example) => example.scores?.[metric]));
  refreshChoices(similarityMetric, supported, similarityMetric.value);
  similarityMetric.dispatchEvent(new Event("change"));
}

async function computeExamples() {
  const snapshot = settingsFor(...exampleKeys);
  if (!exampleKeys.every((key) => get(key).validity.valid)) return;
  cancel(exampleJob);
  const controller = new AbortController();
  exampleJob.request = controller;
  const output = get("example-status");
  output.textContent = "正在计算小样例…";
  try {
    const examples = await api("examples", { settings: snapshot }, controller.signal);
    if (controller.signal.aborted) return;
    setExamples(examples);
    output.textContent = `样例使用 ${snapshot.blur} × ${snapshot.blur} 模糊核、σ ${snapshot.sigma}。`;
  } catch (error) {
    if (!controller.signal.aborted) output.textContent = error.message;
  } finally {
    finish(exampleJob, controller);
  }
}

function playbackTrainingRequest(record) {
  const last = record.rounds.at(-1);
  const notes = Array.from({ length: last.dictionary.length }, () => []);
  const dictionary = Array(last.dictionary.length).fill(null);
  for (const entry of last.learning) {
    if (entry.note) notes[entry.template].push(entry.note);
    if (entry.result) dictionary[entry.template] = notes[entry.template];
  }
  let randomTrials = 0;
  let lastRandomNotes;
  for (const round of record.rounds) {
    for (const trial of round.trials) {
      if (!trial.learned) {
        randomTrials++;
        lastRandomNotes = trial.notes;
      }
    }
  }
  return {
    seed: record.seed,
    config: record.config ?? {
      response_threshold: record.threshold, usefulness_threshold: record.usefulness,
      uniqueness_threshold: record.uniqueness, merge_threshold: record.mergeThreshold,
      spawn_ratio: record.spawnRatio, minimum_captures: record.minimumCaptures,
      capture_margin: record.captureMargin, repulsion: record.repulsion,
    },
    songs: record.songs.map(({ roll, boxes }) => ({ roll, boxes })),
    dictionary, randomTrials, lastRandomNotes, metricNames: record.metricNames,
  };
}

async function runTraining(continuing = false, requestedRounds) {
  if (trainingPending()) return;
  const field = continuing ? null : [...form.elements].find(control => !control.validity.valid &&
    (requestedRounds === undefined || control.name !== "rounds"));
  if (continuing ? !canContinue() : !sourceReady || field) {
    if (sourceReady) {
      const settings = get("iteration-settings");
      if (settings.contains(field) && iterationDialog.open) settings.open = true;
      const panelSettings = field?.closest("details.algorithm-settings");
      if (panelSettings) panelSettings.open = true;
      const label = field?.labels?.[0]?.textContent;
      setTrainingStatus(label ? `请检查「${label}」的数值。` : "请补全参数或将数值调到可用范围。");
    }
    controlsState();
    return;
  }
  const controller = new AbortController();
  trainingJob.request = controller;
  const freshRequest = continuing ? null : {
    ...activeSource(), track: Number(trackSelect.value), settings: settings(),
  };
  const snapshot = freshRequest?.settings;
  if (snapshot && requestedRounds !== undefined) snapshot.rounds = 1;
  controlsState();
  const count = requestedRounds ?? 1;
  function showRoundProgress(completed) {
    const progress = count > 1 ? `（本次 ${completed + 1} / ${count} 轮）` : "";
    const next = continuing ? data.rounds.length + 1 : completed + 1;
    setTrainingStatus(`正在训练第 ${next} 轮${progress}…`);
  }
  try {
    if (freshRequest) {
      if (requestedRounds === undefined) setTrainingStatus(`正在计算 ${snapshot.rounds} 轮训练，完成后可逐步回放。`);
      else showRoundProgress(0);
      const { checkpoint, ...result } = await api("train", freshRequest, controller.signal);
      if (controller.signal.aborted) return;
      trainingRun = { request: freshRequest, checkpoint, action: "continue" };
      state.song = 0;
      state.round = result.rounds.length - 1;
      if (sourceMode.value === "local") result.songs[0].id = localSource.name;
      inputPreview = result.songs[0].preview ?? null;
      cancel(exampleJob);
      setExamples(result.examples);
      get("example-status").textContent = `样例使用本次训练的 ${snapshot.blur} × ${snapshot.blur} 模糊核、σ ${snapshot.sigma}。`;
      updateData(result, true);
    }
    for (let index = continuing ? 0 : 1; index < count; index++) {
      showRoundProgress(index);
      const action = trainingRun?.action ?? "continue-playback";
      const request = trainingRun?.request ?? playbackTrainingRequest(data);
      const { checkpoint, rounds, metrics } = await api(action, {
        ...request, checkpoint: trainingRun?.checkpoint,
      }, controller.signal);
      if (controller.signal.aborted) return;
      trainingRun = { request, checkpoint, action };
      data.rounds.push(...rounds);
      data.metrics.push(...metrics);
      state.round = data.rounds.length - 1;
      updateData(data, true);
    }
    setTrainingStatus(`已完成 ${data.rounds.length} 轮训练。`);
  } catch (error) {
    if (!controller.signal.aborted) setTrainingStatus(error.message);
  } finally {
    finish(trainingJob, controller);
    controlsState();
  }
}

async function recordedPlayback() {
  const inline = get("training-data");
  try {
    if (inline) return JSON.parse(inline.textContent);
    if (location.protocol === "file:") return null;
    const response = await fetch(new URL("training-data.json", document.baseURI));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function showRecordedParameters(record) {
  const config = record?.config ?? {};
  const values = {
    resolution: record?.resolution,
    blur: config.blur_size, sigma: config.random_sigma,
    words: config.initial_templates, height: config.initial_shape?.[0], width: config.initial_shape?.[1],
    noteMin: config.initial_note_count?.[0], noteMax: config.initial_note_count?.[1] - 1,
    durationMin: config.initial_duration?.[0], duration: config.initial_duration?.[1] - 1,
    scales: config.pitch_scales?.join(", "), seed: record?.seed, attempts: config.max_template_attempts,
    similarity: config.uniqueness_threshold ?? record?.uniqueness,
    usefulness: config.usefulness_threshold ?? record?.usefulness,
    notePenalty: config.note_penalty, learnedPenalty: config.learned_penalty,
    threshold: config.response_threshold ?? record?.threshold, repulsion: config.repulsion ?? record?.repulsion,
    capturePitchMargin: config.capture_pitch_margin ?? config.capture_margin ?? record?.captureMargin,
    captureTimeMargin: config.capture_time_margin ?? config.capture_margin ?? record?.captureMargin,
    minimumCaptures: config.minimum_captures ?? record?.minimumCaptures,
    merge: config.merge_threshold ?? record?.mergeThreshold,
    spawnRatio: config.spawn_ratio ?? record?.spawnRatio,
    learnedMin: config.minimum_learned_notes, learnedMax: config.maximum_learned_notes,
    rounds: record?.rounds.length, growth: config.dictionary_growth,
  };
  for (const input of document.querySelectorAll(".parameter-input")) {
    const value = values[input.name];
    input.disabled = true;
    if (value == null || Number.isNaN(value)) {
      input.value = "";
      input.placeholder = "无记录";
    } else {
      input.value = value;
    }
  }
  for (const slider of document.querySelectorAll(".parameter-slider, .range-pair")) {
    slider.hidden = true;
  }
}

async function initialize() {
  launchControls();
  launchAlgorithms();
  controlsState();
  refreshChoices(trackSelect, []);
  refreshChoices(songSelect, []);
  updateData(emptyData);
  const [record, songs] = await Promise.all([
    recordedPlayback(),
    location.protocol === "file:" ? null : api("catalog", {}).catch(() => null),
  ]);
  live = Array.isArray(songs);
  if (record) {
    updateData(record);
    setExamples(record.examples ?? []);
  }
  if (live) {
    const recordedSong = currentSong()?.id;
    const selected = refreshChoices(songSelect, songs.map((song) => [`${song.name} · ${song.id}`, song.id]), recordedSong);
    if (!selected || (recordedSong && recordedSong !== selected)) sourceMode.value = "local";
    initializeSharedAnnotations();
    await Promise.all([loadSource(Boolean(record)), computeExamples()]);
  } else {
    refreshChoices(songSelect, data.songs.map((song, index) => [song.id, index]), 0);
    refreshChoices(trackSelect, record ? [[`音轨 ${record.track}`, record.track]] : [], record?.track);
    sourceMode.disabled = upload.disabled = trackSelect.disabled = true;
    form.hidden = true;
    get("iteration-status").textContent = "离线回放";
    showRecordedParameters(record);
    renderStage("similarity");
    songSelect.addEventListener("change", () => {
      if (!live) {
        provenance.textContent = `当前记录 · ${data.songs[Number(songSelect.value)].id} · 音轨 ${data.track} · 种子 ${data.seed}`;
        clearInputAnnotations();
        changeRun("song", Number(songSelect.value));
        loadInputAnnotations();
      }
    });
    status.textContent = record ? "离线训练回放。切换原始 MIDI 和重新计算需要本地工作台。"
      : "没有可用的训练回放。请使用 npm run dev 启动本地工作台。";
    if (record) await loadInputAnnotations();
  }
  syncAlgorithmControls();
  for (const mode of document.querySelectorAll(".algorithm-mode")) {
    mode.textContent = live ? "修改参数后自动重算" : "离线记录 · 参数只读";
  }
}

await initialize();

window.MusicWordParameters = {
  validate(values) {
    if (!live) throw new Error("ActiveBasis 参数只读，请使用本地工作台。");
    if (!values?.parameters || !values.view) throw new Error("ActiveBasis 参数方案无效。");
    for (const field of document.querySelectorAll(".parameter-input")) {
      const value = values.parameters[field.name];
      const copy = field.cloneNode(true);
      copy.disabled = false;
      copy.value = value;
      if (value === undefined || !copy.checkValidity()) throw new Error("ActiveBasis 参数超出允许范围：" + field.name);
    }
    const p = values.parameters;
    if (!String(p.scales).split(",").every((value) => value.trim() && Number.isFinite(Number(value)) && Number(value) > 0) ||
        [["noteMin", "noteMax"], ["durationMin", "duration"], ["learnedMin", "learnedMax"]]
          .some(([min, max]) => Number(p[min]) > Number(p[max]))) throw new Error("ActiveBasis 参数范围无效。");
    if (!(values.view.roundBatchCount === "" || (Number.isSafeInteger(Number(values.view.roundBatchCount)) && Number(values.view.roundBatchCount) > 0)) ||
        !["0", "1", "2", "3"].includes(String(values.view.windowSize)) || typeof values.view.blurred !== "boolean" ||
        !Array.from(similarityMetric.options).some((option) => option.value === values.view.similarityMetric) ||
        !values.view.speeds || panels.some((panel) => !Array.from(panel.parts.speed.options)
          .some((option) => option.value === values.view.speeds[panel.key]))) throw new Error("ActiveBasis 显示参数无效。");
  },
  snapshot() {
    const values = {
      parameters: Object.fromEntries(Array.from(document.querySelectorAll(".parameter-input"), (field) => [field.name, field.value])),
      view: {roundBatchCount: roundBatchCount.value, windowSize: get("window-size").value, blurred: get("blurred").checked, similarityMetric: similarityMetric.value,
        speeds: Object.fromEntries(panels.map((panel) => [panel.key, panel.parts.speed.value]))},
    };
    this.validate(values);
    return values;
  },
  apply(values) {
    this.validate(values);
    for (const panel of panels) stop(panel);
    const fields = [...document.querySelectorAll(".parameter-input")];
    for (const field of fields) field.value = values.parameters[field.name];
    // Set the whole form first; all mirrors and paired sliders read one complete snapshot.
    for (const field of fields) field.dispatchEvent(new Event("input", {bubbles: true}));
    get("window-size").value = values.view.windowSize;
    get("window-size").dispatchEvent(new Event("input"));
    get("blurred").checked = values.view.blurred;
    get("blurred").dispatchEvent(new Event("change"));
    similarityMetric.value = values.view.similarityMetric;
    similarityMetric.dispatchEvent(new Event("change"));
    for (const panel of panels) panel.parts.speed.value = values.view.speeds[panel.key];
    roundBatchCount.value = values.view.roundBatchCount;
    syncRoundActions();
    syncAlgorithmControls();
  },
};

window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll);
const updateTopbarHeight = () => {
  document.documentElement.style.setProperty("--topbar-height", `${topbar.offsetHeight}px`);
  onScroll();
};
new ResizeObserver(updateTopbarHeight).observe(topbar);
updateTopbarHeight();
window.addEventListener("keydown", (event) => {
  if (document.querySelector(".playback-dialog[open]")) return;
  const panel = byStage(state.activeStage);
  if (!panel || panel.parts.transport.hidden ||
      event.target.closest?.("a, button, select, input, textarea, [contenteditable], .relearning-captures, .formula-expression")) return;
  if (event.key === " ") { event.preventDefault(); play(panel); }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault(); stop(panel); setStep(panel, panel.step + (event.key === "ArrowLeft" ? -1 : 1));
  }
});
const initialSection = get(location.hash.slice(1));
if (initialSection?.matches(".playback-stage")) initialSection.scrollIntoView();
syncLocation();
