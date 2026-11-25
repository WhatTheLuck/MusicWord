"use strict";

const $ = (id) => document.getElementById(id);
const form = $("settings");
const mirroredParameters = document.querySelectorAll("[data-param]");
const parameterFields = form.querySelectorAll("[name]");
const presetSelect = $("presetSelect");
const savePresetButton = $("savePreset");
const presets = new Map();
const unsavedOption = new Option("当前参数（未保存）", "unsaved");
unsavedOption.disabled = true;
const strideLabels = ["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8"];
const strideStops = strideLabels.map((_, index) => 2 ** (index - 5));
const embedded = $("embedded");
const rawButton = $("raw");
const showRectanglesButton = $("showRectangles");
const splitOverlapsButton = $("splitOverlapsButton");
const removeSelfSimilarityButton = $("removeSelfSimilarityButton");
const padTreeParentsButton = $("padTreeParents");
const canvas = $("matrix");
const resetMatrixButton = $("resetMatrixView");
const outline = $("overlay");
const matrixTooltip = $("matrixTooltip");
const retryStride = $("retryStride");
const thumbnailCursor = $("thumbnailCursor");
const roll = $("roll");
const rollCursor = $("rollCursor");
const annotationRoll = $("annotationRoll");
const metricChart = $("metricChart");
const plotLeft = 64, plotRight = 10;
const matrixTop = 10, matrixBottom = 28;
const thumbnailLeft = 5, thumbnailWidth = 31;
const treeNodeHeight = 20;
const cellHint = "悬浮查看 A、B 比对位置，点击选中附近的匹配斜线。";
const palette = [[23,24,48], [60,56,120], [133,115,188], [216,170,188], [252,226,159]];
const colorA = "#f6a35f";
const colorB = "#66d6c5";
const treeClassColors = ["#e7aa46", "#62b6cb", "#d884b7", "#8fca79", "#a89be8", "#e18763", "#a4ae4d", "#80a4ef"];
const fixedTreeColors = {root: "#c2bcdb", unique: "#e0d5bd", fill: "#91a3b8"};
let result, matrix, image, geometry, selection, cursor, uploadedFile;
let sharedApi, sharedControls, sharedReference, sharedFile, resultFile, midiPicker;
let annotationView, annotationGeometry;
let comparisonHistory, metricHover;
let renderedAnnotation, annotationWidth, annotationColors;
let pending = false, showRawMatrix = false;
let showRectangles = false;
let revision = 0, recalcTimer, recalcQueued = false;
let nextSource;
let hoveredLine, timelineHover, rollGeometry;
let rollNotesByOnset = [];
let hoveredRectangle = -1, rectangleMatches = [];
const matrixView = {zoom: 1, x: 0, y: 0};
let matrixDrag, suppressMatrixClick = false;
const clampMatrixOffset = (offset) => Math.max(0, Math.min(matrixView.zoom - 1, offset));
let mirroredHover = false;
const treeButtons = new Map();
const treeLevelButtons = new Map();
let treeItems = [], treeWidth = 0;
let hoveredTreeLevel = null, pinnedTreeLevel = null;
let treeLevelHighlight = {ranges: [], lines: new Map()};
let padTreeParents = true;
const previewAudio = window.MusicWordPreview;
let audition, playHead;
let shownLines = [], shortLines = new Set(), selectableLines = [], splitSources = new Map();
const modes = { NCC: "NCC", SAD: "SAD", TEXTON: "Texton" };
const formatter = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 2});
const coordinateFormatter = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 5});
const beat = (tick) => formatter.format(tick / result.tpb);
const interval = ([start, end]) => beat(start) + "–" + beat(end) + " 拍";
const strideLabel = (value) => strideLabels[strideStops.indexOf(value)] ?? String(value);
const overlapTicks = (line, stride) => Math.max(0, line[1] + stride - line[2]);
const minimumLineCells = (data) => Math.max(2, Math.ceil(data.config.minBeats * data.tpb / data.stride));
const text = (id, value) => { $(id).textContent = value; };

function status(value, isError = false) {
  text("status", value);
  $("status").classList.toggle("error", isError);
}
function syncMode() {
  const texton = form.elements.mode.value === "TEXTON";
  const sad = form.elements.mode.value === "SAD";
  form.elements.stride.disabled = texton || Boolean(embedded);
  if (texton) form.elements.stride.value = "1";
  $("sadSetting").hidden = !sad;
  form.elements.sadSigma.disabled = !sad || Boolean(embedded);
}

for (const slider of form.querySelectorAll("[data-ticks]")) {
  const ticks = document.createElement("span");
  ticks.className = "parameter-ticks";
  ticks.setAttribute("aria-hidden", "true");
  const min = Number(slider.min), max = Number(slider.max), step = Number(slider.step);
  for (let value = min; value <= max; value += step) {
    const tick = document.createElement("span");
    tick.dataset.value = value;
    if (value === max || (value - min) % Number(slider.dataset.ticks) === 0) {
      const label = document.createElement("span");
      label.textContent = value;
      tick.append(label);
    }
    ticks.append(tick);
  }
  slider.after(ticks);
}

function syncParameterMirrors() {
  splitOverlapsButton.setAttribute("aria-pressed", String(form.elements.splitOverlaps.checked));
  removeSelfSimilarityButton.setAttribute("aria-pressed", String(form.elements.removeSelfSimilarity.checked));
  for (const mirror of mirroredParameters) {
    const field = form.elements.namedItem(mirror.dataset.param);
    let displayValue = field.value;
    if (mirror.dataset.param === "stride") {
      const stride = Number(field.value);
      displayValue = String(Math.max(0, Math.min(strideStops.length - 1, Math.round(Math.log2(stride)) + 5)));
      mirror.setAttribute("aria-valuetext", strideLabel(stride) + " 拍");
      const marks = mirror.nextElementSibling.children;
      for (const [index, mark] of Array.from(marks).entries()) mark.classList.toggle("is-current", index === Number(displayValue));
    }
    if (mirror.type === "checkbox") mirror.checked = field.checked;
    else if (mirror.value !== displayValue && (mirror.type !== "range" || field.validity.valid)) mirror.value = displayValue;
    mirror.disabled = Boolean(embedded) || field.disabled;
    if (mirror.dataset.ticks) {
      for (const tick of mirror.nextElementSibling.children) {
        tick.classList.toggle("is-current", Number(tick.dataset.value) === Number(mirror.value));
      }
    }
  }
  for (const value of document.querySelectorAll("[data-stride-value]")) {
    value.textContent = strideLabel(Number(form.elements.stride.value));
  }
  const threshold = Number(form.elements.threshold.value).toFixed(2);
  text("thresholdValue", threshold);
  text("codeThresholdValue", threshold);
}
function trackList(tracks, selected) {
  const options = tracks.map((track) => new Option(
    (track.index + 1) + " · " + (track.name.replace(/[\u0000-\u001f\u007f]/g, "").trim() || (track.is_drum ? "打击乐" : "音色 " + track.program)) +
      "（" + track.n_notes + " 音符）", track.index
  ));
  $("track").replaceChildren(...options);
  $("track").value = selected;
}
function requestOptions(file) {
  return file ? {method: "POST", body: file, headers: {
    "Content-Type": "application/octet-stream",
    "X-Midi-Name": encodeURIComponent(file.name)
  }} : {};
}
async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("无法连接本地工作台。请确认 start.cmd 正在运行。");
  }
  const data = await response.json().catch(() => {
    throw new Error("本地工作台返回了无法读取的结果。");
  });
  if (!response.ok) {
    const error = new Error(data.error || "分析请求失败。");
    error.suggestedStride = data.suggestedStride;
    throw error;
  }
  return data;
}

function parameterSnapshot() {
  const settings = {};
  for (const field of parameterFields) {
    let value = field.type === "checkbox" ? field.checked : field.type === "number" ? field.valueAsNumber : field.value;
    if (field.name === "sadSigma" && field.disabled &&
        !(field.valueAsNumber >= Number(field.min) && field.valueAsNumber <= Number(field.max))) {
      value = Number(field.defaultValue);
    }
    settings[field.name] = value;
  }
  return {...settings, padTreeParents};
}

function setParameterValues(values) {
  for (const field of parameterFields) {
    if (!Object.hasOwn(values, field.name)) continue;
    if (field.type === "checkbox") field.checked = Boolean(values[field.name]);
    else field.value = values[field.name];
  }
  syncMode();
  syncParameterMirrors();
}

function setPresetStatus(message, isError = false) {
  text("presetStatus", message);
  $("presetStatus").classList.toggle("error", isError);
}

function addPreset(preset, newest = false) {
  presets.set(preset.id, preset.settings);
  const date = new Date(preset.savedAt).toLocaleString("zh-CN", {hour12: false});
  const option = new Option(`${date} · ${modes[preset.settings.mode]}`, preset.id);
  presetSelect.add(option, newest ? 1 : unsavedOption.index);
}

function selectPreset(id) {
  presetSelect.value = id;
  unsavedOption.hidden = id !== "unsaved";
}

function markPresetEdited() {
  selectPreset("unsaved");
  setPresetStatus("");
}

function loadPreset(id) {
  const settings = presets.get(id);
  if (!settings) return;
  setParameterValues(settings);
  setPadTreeParents(settings.padTreeParents ?? true);
  selectPreset(id);
}

async function initializePresets() {
  const defaults = Object.fromEntries(Array.from(parameterFields, (field) => [field.name,
    field.type === "checkbox" ? field.defaultChecked : field.type === "select-one"
      ? Array.from(field.options).find((option) => option.defaultSelected)?.value ?? field.options[0].value
      : field.defaultValue,
  ]));
  presets.set("default", {...defaults, padTreeParents: true});
  unsavedOption.hidden = true;
  presetSelect.add(unsavedOption);
  presetSelect.disabled = true;
  $("presetBar").hidden = false;
  syncMode();
  syncParameterMirrors();
  try {
    const saved = await request("./api/presets");
    for (const preset of saved) addPreset(preset);
    if (presetSelect.value === "default") loadPreset(saved[0]?.id ?? "default");
  } catch (error) {
    setPresetStatus("无法加载参数方案。" + error.message, true);
  } finally {
    presetSelect.disabled = savePresetButton.disabled = false;
  }
}

async function saveCurrentPreset() {
  if (!form.reportValidity()) return;
  const settings = parameterSnapshot();
  savePresetButton.disabled = true;
  setPresetStatus("正在保存…");
  try {
    const preset = await request("./api/presets", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(settings),
    });
    addPreset(preset, true);
    if (JSON.stringify(parameterSnapshot()) === JSON.stringify(settings)) selectPreset(preset.id);
    setPresetStatus("已保存 JSON");
  } catch (error) {
    setPresetStatus(error.message, true);
  } finally {
    savePresetButton.disabled = false;
  }
}
function setBusy(busy, switchingSource = false) {
  pending = busy;
  $("example").disabled = $("file").disabled = busy;
  if (midiPicker) midiPicker.select.disabled = busy;
  $("track").disabled = switchingSource;
  $("export").disabled = busy || !result;
}
function setMatchCount(message, error = false) {
  text("matchCount", message);
  $("matchCount").classList.toggle("error", error);
  $("matrixError").hidden = true;
  retryStride.hidden = true;
}
function queueRecalculation() {
  setMatchCount("等待重新计算…");
  revision++;
  recalcQueued = false;
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => run(), 280);
}
async function run({file, example, pop909, inspect = Boolean(pop909), annotationDocument} = {}) {
  if (pending) {
    if (file || example || pop909) {
      return new Promise((resolve) => {
        nextSource?.resolve(false);
        nextSource = { options: { file, example, pop909, inspect, annotationDocument }, resolve };
      });
    }
    recalcQueued = true;
    return;
  }
  if (!form.checkValidity()) {
    status("请检查分析参数的取值。", true);
    setMatchCount("参数有误 · 当前 " + shownLines.length + " 条", true);
    return;
  }
  setBusy(true, Boolean(inspect || example));
  let requestRevision = revision;
  status(inspect ? "正在读取 MIDI 音轨…" : "正在计算自相似矩阵…");
  try {
    if (pop909) file = await sharedApi.pop909MidiFile(pop909.id, pop909.label);
    let track = example ? "0" : $("track").value;
    let tracks = result?.tracks;
    if (inspect) {
      const metadata = await request("./api/tracks", requestOptions(file));
      tracks = metadata.tracks;
      const signatures = new Set(annotationDocument?.tracks
        .filter((track) => track.layers.some((layer) => layer.words.some((word) => !word.automatic)))
        .map((track) => track.signature));
      const first = metadata.tracks.find((instrument) => signatures.has(instrument.signature)) ??
        metadata.tracks.find((instrument) => instrument.n_notes > 0);
      if (!first) throw new Error("该 MIDI 没有可分析的音轨。");
      trackList(metadata.tracks, first.index);
      track = first.index;
    }
    if (file) {
      uploadedFile = file;
      text("fileName", file.name);
      if (!pop909) $("example").value = "";
      midiPicker?.setSelection($("example").value, annotationDocument?.song.name ?? file.name);
    }
    if (example) {
      uploadedFile = null;
      $("file").value = "";
      text("fileName", "MIDI / MusicXML");
      $("track").value = track;
      midiPicker?.setSelection($("example").value);
    }
    requestRevision = revision;
    clearTimeout(recalcTimer);
    recalcQueued = false;
    if (!form.checkValidity()) throw new Error("请检查分析参数的取值。");
    const values = new URLSearchParams(new FormData(form));
    values.set("splitOverlaps", form.elements.splitOverlaps.checked ? "1" : "0");
    values.set("removeSelfSimilarity", form.elements.removeSelfSimilarity.checked ? "1" : "0");
    if (track !== "") values.set("track", track);
    values.set("key", $("example").value);
    const reference = annotationDocument ? { document: annotationDocument }
      : uploadedFile === sharedFile ? sharedReference : null;
    const scope = annotationScope(reference, tracks, track);
    if (scope?.window) {
      values.set("annotationStart", scope.window[0]);
      values.set("annotationEnd", scope.window[1]);
    }
    status("正在计算自相似矩阵…");
    setMatchCount("正在更新匹配…");
    const data = await request((uploadedFile ? "./api/analyze?" : "./api/example?") + values, requestOptions(uploadedFile));
    if (!(data.version >= 2) || data.config?.parentEdgeTolerance !== Number(values.get("parentEdgeTolerance")) ||
        !Array.isArray(data.rectangles) || !Array.isArray(data.rectangleRemovedCounts) ||
        !Number.isInteger(data.removedLineCount)) {
      throw new Error("SSM 分析服务仍在运行旧版本。请重启本地工作台后刷新页面。");
    }
    if (scope?.window && !data.annotationRange) {
      throw new Error("请重启工作台，以启用按标注时间范围分析。");
    }
    if (requestRevision === revision) {
      resultFile = uploadedFile;
      apply(data);
      return true;
    }
  } catch (error) {
    if (inspect && uploadedFile !== file) $("file").value = "";
    if (requestRevision === revision || inspect) {
      const message = error.message || "无法连接本地工作台。";
      status(message, true);
      setMatchCount(result ? "更新失败 · 仍显示上次 " + shownLines.length + " 条" : "计算失败", true);
      text("matrixErrorMessage", message);
      $("matrixError").hidden = false;
      if (strideStops.includes(error.suggestedStride)) {
        text("retryStride", "用 " + strideLabel(error.suggestedStride) + " 拍重算");
        retryStride.value = error.suggestedStride;
        retryStride.hidden = false;
      }
    }
  } finally {
    setBusy(false);
    if (nextSource) {
      const { options, resolve } = nextSource;
      nextSource = null;
      recalcQueued = false;
      resolve(run(options));
    } else if (recalcQueued) run();
  }
}
function apply(data) {
  stopAudio();
  finishMatrixDrag();
  result = data;
  rollNotesByOnset = [...data.notes].sort((a, b) => a[0] - b[0]);
  Object.assign(matrixView, {zoom: 1, x: 0, y: 0});
  const binary = atob(data.matrix);
  const encoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // The serialization is explicitly little-endian.
  const reader = new DataView(encoded.buffer);
  matrix = new Float32Array(data.size ** 2);
  for (let index = 0; index < matrix.length; index++) matrix[index] = reader.getFloat32(index * 4, true);
  trackList(data.tracks, data.config.track);
  const settings = {...data.config};
  if (!embedded && settings.mode !== "SAD") delete settings.sadSigma;
  setParameterValues(settings);
  canvas.classList.remove("near-match", "crosshair");
  text("summary", data.name + "  ·  音轨 " + (data.config.track + 1) + "  ·  " +
    beat(data.ticks - 1) + " 拍  ·  起始 " + formatter.format(data.bpm) + " BPM");
  status(modes[data.config.mode] + "  /  " + data.size + " × " + data.size + "  /  " + data.elapsedMs + " ms");
  $("play").disabled = !data.notes.length;
  $("export").disabled = Boolean(embedded);
  shownLines = [...data.lines].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0] || a[2] - b[2]);
  shortLines = new Set(data.shortLines ?? []);
  splitSources = new Map((data.splitSources ?? []).map(([piece, original]) => [piece.join(","), original]));
  selectableLines = [...shownLines, ...shortLines];
  setMatchCount("匹配 " + shownLines.length + " 条");
  $("shortMatchCount").hidden = !shortLines.size;
  text("shortMatchCount", "短斜线 " + shortLines.size + " 条");
  $("rectangleCount").hidden = !data.rectangles;
  text("rectangleCount", "矩形 " + (data.rectangles?.length ?? 0) + " 个");
  $("removedLineCount").hidden = !data.config.removeSelfSimilarity;
  text("removedLineCount", "已去重 " + (data.removedLineCount ?? 0) + " 条斜线");
  matrixTooltip.hidden = true;
  selection = cursor = hoveredLine = timelineHover = null;
  hoveredTreeLevel = pinnedTreeLevel = null;
  treeLevelHighlight = {ranges: [], lines: new Map()};
  hoveredRectangle = -1;
  rectangleMatches = [];
  mirroredHover = false;
  treeItems = buildTreeItems(data.nodes);
  if (embedded) annotationView = data.annotationView;
  else updateSharedAnnotation();
  if (embedded) padTreeParents = data.padTreeParents ?? true;
  padTreeParentsButton.disabled = false;
  padTreeParentsButton.setAttribute("aria-pressed", String(padTreeParents));
  treeWidth = 0;
  text("cell", cellHint);
  const cells = minimumLineCells(data);
  text("codeEffectiveStride", strideLabel(data.stride / data.tpb));
  text("codeMinCells", cells);
  text("lineParams", "本次计算 · 阈值 " + data.config.threshold.toFixed(2) + " · 步长 " + strideLabel(data.stride / data.tpb) + " 拍 · 连续至少 " + cells + " 格");
  buildHeatmap();
  drawEverything();
  updateAuditionButtons();
}

function annotationScope(reference, tracks, index) {
  if (!reference) return null;
  const signature = tracks?.find((track) => track.index === Number(index))?.signature;
  const track = sharedApi.referenceTrack(reference, signature);
  if (!track) return null;
  const options = sharedApi.referenceLayers(reference.document, [track]);
  const layer = options.has(reference.layer) ? reference.layer : options.keys().next().value;
  const segments = sharedApi.referenceSegments({ ...reference, layer }, track);
  return { track, layer, window: sharedApi.referenceWindow(segments) };
}

function updateSharedAnnotation() {
  annotationView = null;
  if (!sharedReference || !sharedControls || !result) {
    resetMetricHistory();
    return;
  }
  if (resultFile !== sharedFile) {
    resetMetricHistory();
    sharedControls.setTrackLayers(null);
    sharedControls.setScore("当前 MIDI 与所加载的标注不同。");
    return;
  }
  const scope = annotationScope(sharedReference, result.tracks, result.config.track);
  sharedControls.setTrackLayers(scope?.track);
  if (!scope?.window) {
    resetMetricHistory();
    sharedControls.setScore("当前音轨在所选层没有可对齐的人工标注。");
    return;
  }
  const { track, layer: layerId, window } = scope;
  sharedReference = { ...sharedReference, layer: layerId };
  if (!window.every((tick, index) => tick === result.annotationRange?.[index])) {
    resetMetricHistory();
    sharedControls.setScore("正在更新标注时间范围…");
    return true;
  }
  const scale = result.tpb / sharedReference.document.timing.sourcePpq;
  const project = (note) => sharedApi.projectWindowNote(note, window, scale);
  const layers = track.layers.map((layer) => ({
    name: layer.name,
    segments: sharedApi.referenceSegments({...sharedReference, layer: layer.id}, track).flatMap((segment) => {
      const notes = segment.notes.map(project).filter(Boolean);
      return notes.length ? [{...segment, notes, noteIds: notes.map(({id}) => id), box: sharedApi.noteBox(notes)}] : [];
    }),
  }));
  const selected = track.layers.findIndex((layer) => layer.id === layerId);
  const segments = layers[selected]?.segments ?? [];
  if (layers.some((layer) => layer.segments.length)) annotationView = {layers, selected};
  if (!segments.length) {
    sharedControls.setScore("当前音轨在所选层没有可对齐的人工标注。");
    return;
  }
  const parents = new Set(result.nodes.map((node) => node.parent));
  const leaves = result.nodes.filter((_, index) => !parents.has(index));
  const notes = track.notes.map(project).filter(Boolean);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const groups = sharedApi.groupsInBoxes(notes, leaves.map(({start, end}) => [start, 0, end, 128]));
  const predictions = [];
  for (const [index, leaf] of leaves.entries()) {
    const noteIds = groups[index];
    if (!noteIds.length) continue;
    const [, low, , high] = sharedApi.noteBox(noteIds.map((id) => noteById.get(id)));
    // Each unmatched leaf is its own segment, with no inferred similarity class.
    const categoryId = ["root", "unique", "fill"].includes(leaf.class) ? `leaf:${index}` : leaf.class;
    predictions.push({ noteIds, categoryId, box: [leaf.start, low, leaf.end, high] });
  }
  const counts = sharedApi.fragmentCounts(segments.map((segment) => segment.noteIds), groups);
  sharedControls.setScore(sharedApi.formatScores(counts, "结构树底层"));
  const scores = sharedControls.compare([sharedApi.comparisonTrack(notes, segments, predictions)], { retainResult: true });
  recordMetricResult(scores, counts, track.trackId, layerId);
}

const metricColors = ["#ad9cf9", "#f2b66a", "#5fd2c1", "#ed92b9", "#8dbaff", "#c4dc7c", "#f88d7c", "#e2e7f2"];
const metricNumbers = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3, minimumFractionDigits: 3 });

function resetMetricHistory() {
  comparisonHistory = metricHover = null;
  $("metricHistory").hidden = true;
}

function recordMetricResult(scores, counts, track, layer) {
  if (comparisonHistory?.file !== resultFile || comparisonHistory?.track !== track || comparisonHistory?.layer !== layer) {
    resetMetricHistory();
    comparisonHistory = { file: resultFile, track, layer, entries: [] };
  }
  const history = comparisonHistory;
  const settings = JSON.stringify(result.config);
  if (history.entries.at(-1)?.settings === settings) return;
  const entry = { settings, counts };
  history.entries.push(entry);
  scores.then((values) => {
    if (history !== comparisonHistory) return;
    if (values) entry.values = { ...values, ...sharedApi.fragmentMetrics(counts) };
    else history.entries.splice(history.entries.indexOf(entry), 1);
    drawMetricHistory();
  });
}

function drawMetricHistory() {
  const points = comparisonHistory?.entries.filter(({ values }) => values) ?? [];
  $("metricHistory").hidden = !points.length;
  if (!points.length) return;
  const {ctx, width, height} = canvasContext(metricChart);
  if (!width) return;
  const left = 40, right = width - 18, top = 12, bottom = height - 24;
  const lower = Math.min(0, ...points.map(({ values }) => Math.floor(values.ARI * 4) / 4));
  const x = (index) => left + index * (right - left) / Math.max(1, points.length - 1);
  const y = (value) => bottom - (value - lower) * (bottom - top) / (1 - lower);
  const selected = Math.min(metricHover ?? points.length - 1, points.length - 1);
  const ticks = lower === 0 ? [0, .5, 1] : [lower, 0, .5, 1];
  ctx.font = "11px Segoe UI";
  ctx.fillStyle = plotColors.chartMuted;
  ctx.textAlign = "right";
  for (const value of ticks) {
    ctx.strokeStyle = plotColors.chartGridStrong;
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
    ctx.fillText(value, left - 7, y(value) + 4);
  }
  ctx.textAlign = "center";
  for (const index of new Set([0, points.length - 1])) ctx.fillText(index + 1, x(index), height - 7);
  ctx.strokeStyle = plotColors.chartMuted;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x(selected), top);
  ctx.lineTo(x(selected), bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  const { values: selectedValues, counts } = points[selected];
  const pointStep = Math.max(1, Math.ceil(points.length * 5 / Math.max(1, right - left)));
  $("metricLegend").replaceChildren(...sharedApi.historyMetricNames.map(([key, label], series) => {
    const color = metricColors[series];
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(series >= sharedApi.metricNames.length ? [4, 3] : []);
    ctx.beginPath();
    for (const [index, { values }] of points.entries()) {
      if (index === 0) ctx.moveTo(x(index), y(values[key]));
      else ctx.lineTo(x(index), y(values[key]));
    }
    ctx.stroke();
    for (const [index, { values }] of points.entries()) {
      if (index !== selected && index % pointStep) continue;
      ctx.beginPath();
      ctx.arc(x(index), y(values[key]), index === selected ? 3.2 : 2, 0, 2 * Math.PI);
      ctx.fill();
    }
    const legend = document.createElement("li");
    legend.style.setProperty("--metric-color", color);
    legend.textContent = label + " " + metricNumbers.format(selectedValues[key]);
    return legend;
  }));
  ctx.setLineDash([]);
  text("metricPoint", `第 ${selected + 1} 次 / 共 ${points.length} 次 · 精确匹配 ${counts.matches}/${counts.manual}`);
}

async function loadClassicalExamples() {
  const songs = await request("./api/examples");
  if (!songs.length) return null;
  const group = document.createElement("optgroup");
  group.label = "经典曲目";
  group.append(...songs.map((song) => new Option(song.name, song.id)));
  $("example").append(group);
  return group;
}

async function initializeSharedAnnotations(classicalExamples) {
  const toolbar = window.frameElement?.ownerDocument.getElementById("ssm-source-slot") ??
    (location.pathname === "/ssm/" ? $("localSourceTools") : null);
  if (!toolbar) return;
  try {
    sharedApi = await import(new URL("/shared-annotations.mjs", location.origin).href);
    sharedControls = sharedApi.mountAnnotationControls($("sharedAnnotationMount"), {
      toolbar,
      async onLoad(document, file) {
        if (!await run({file, inspect: true, annotationDocument: document})) {
          throw new Error("标注的 MIDI 尚未计算，请检查分析设置后重试。");
        }
        sharedFile = file;
      },
      onChange(reference) {
        sharedReference = reference;
        if (updateSharedAnnotation()) queueRecalculation();
        drawAnnotation();
      },
    });
  } catch (error) {
    text("sharedAnnotationMount", error.message);
  }
  if (!sharedApi) return;
  const example = $("example");
  midiPicker = sharedApi.mountMidiPicker(toolbar, {
    input: $("file"),
    onPreset(value) {
      example.value = value;
      selectExample(example);
    },
  });
  midiPicker.select.disabled = pending;
  midiPicker.setSelection(example.value, uploadedFile?.name);
  example.closest("label").hidden = true;
  const download = $("file").closest("label").nextElementSibling;
  if (download?.matches(".mw-converted-midi")) toolbar.append(download);
  $("file").closest(".upload").hidden = true;
  if (toolbar === $("localSourceTools")) toolbar.hidden = false;
  const examples = document.createElement("optgroup");
  examples.label = "SSM 示例";
  examples.append(...Array.from(example.options).filter((option) => option.value && option.parentElement === example)
    .map((option) => option.cloneNode(true)));
  midiPicker.setPresets([examples]);
  const classical = await classicalExamples;
  const presets = classical ? [examples, classical.cloneNode(true)] : [examples];
  midiPicker.setPresets(presets);
  const group = document.createElement("optgroup");
  group.label = "POP909 曲目";
  try {
    const songs = (await sharedApi.pop909Catalog()).filter((song) => song.collection !== "classical");
    group.append(...songs.map((song) => new Option(sharedApi.pop909Label(song), `pop909:${song.id}`)));
    if (!songs.length) group.append(new Option("暂无可用曲目", ""));
  } catch (error) {
    const option = new Option(error.message, "");
    option.disabled = true;
    group.append(option);
  }
  example.append(group.cloneNode(true));
  midiPicker.setPresets([...presets, group]);
}

function canvasContext(element) {
  const {width, height} = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const wp = Math.round(width * ratio), hp = Math.round(height * ratio);
  if (element.width !== wp) element.width = wp;
  if (element.height !== hp) element.height = hp;
  const ctx = element.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return {ctx, width, height};
}
function ramp(score) {
  const value = Math.min(Math.max(score, 0), 1) * (palette.length - 1);
  const first = Math.floor(value), last = Math.min(first + 1, palette.length - 1);
  return palette[first].map((channel, index) => Math.round(channel + (palette[last][index] - channel) * (value - first)));
}
function buildHeatmap() {
  if (!result) return;
  const count = result.size;
  image = document.createElement("canvas");
  image.width = image.height = count;
  const ctx = image.getContext("2d");
  const pixels = ctx.createImageData(count, count);
  const raw = showRawMatrix;
  const signed = raw && result.config.mode === "NCC";
  const colors = Array.from({length: 256}, (_, i) => ramp(i / 255));
  text("legendMin", signed ? "−1" : "0");
  for (let y = 0; y < count; y++) {
    for (let x = 0; x <= y; x++) {
      let value = matrix[y * count + x];
      if (!Number.isFinite(value)) continue;
      if (!raw && value < result.config.threshold) value = 0;
      if (signed) value = (value + 1) / 2;
      const rgb = colors[Math.min(255, Math.max(0, Math.round(value * 255)))];
      const pixel = (x * count + y) * 4;
      pixels.data[pixel] = rgb[0];
      pixels.data[pixel + 1] = rgb[1];
      pixels.data[pixel + 2] = rgb[2];
      pixels.data[pixel + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
}
function beatTicks(end, width) {
  const guide = Math.max(end / Math.max(2, width / 58), .125);
  const magnitude = 10 ** Math.floor(Math.log10(guide));
  const factor = [1, 2, 5, 10].find((n) => n * magnitude >= guide) ?? 10;
  const subdivisions = factor === 2 ? 4 : 5;
  const step = factor * magnitude / subdivisions;
  const count = Math.floor(end / step + 1e-8);
  return Array.from({length: count + 1}, (_, i) => ({beat: i * step, major: i % subdivisions === 0}));
}
function rectanglePixels([col, row, cols, rows]) {
  const {left, top, cellX, cellY} = geometry;
  return [left + row * cellX, top + col * cellY, rows * cellX, cols * cellY];
}
function readPlotColors() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name, fallback) => styles.getPropertyValue('--mw-' + name).trim() || fallback;
  return {
    field: color('raised', '#e7e5ef'),
    label: color('muted', '#575466'),
    line: color('line', '#dedbea'),
    strong: color('strong-line', '#8f88a8'),
    chart: color('chart', '#171830'),
    chartGrid: color('chart-grid', '#b8b3dd20'),
    chartGridStrong: color('chart-grid-strong', '#b8b3dd45'),
    chartMuted: color('chart-muted', '#cfcae0'),
  };
}
let plotColors = readPlotColors();
document.addEventListener('musicword:themechange', () => {
  plotColors = readPlotColors();
  if (canvas.clientWidth) drawEverything();
});

function drawMatrix() {
  if (!result) return;
  resetMatrixButton.hidden = matrixView.zoom === 1;
  const {ctx, width, height} = canvasContext(canvas);
  const timelineWidth = Math.max(1, width - plotLeft - plotRight);
  const baseScale = timelineWidth / result.ticks;
  const viewHeight = result.size * result.stride * baseScale;
  const scale = baseScale * matrixView.zoom;
  const left = plotLeft - matrixView.x * timelineWidth;
  const top = matrixTop - matrixView.y * viewHeight;
  const cellX = scale * result.stride;
  const spanX = result.size * cellX;
  const spanY = spanX;
  const cellY = cellX;
  const scaleY = scale;
  geometry = {left, top, spanY, cellX, cellY, scale, scaleY, timelineWidth, viewHeight};
  ctx.save();
  clipMatrix(ctx);
  ctx.fillStyle = plotColors.field;
  ctx.fillRect(plotLeft, matrixTop, timelineWidth, viewHeight);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, left, top, spanX, spanY);
  drawBaseMatches(ctx);
  if (showRectangles && result.rectangles?.length) {
    ctx.save();
    const boxes = new Path2D();
    // The matrix display transposes the stored lower triangle.
    for (const rectangle of result.rectangles) boxes.rect(...rectanglePixels(rectangle));
    ctx.strokeStyle = "#221823";
    ctx.lineWidth = 3.2;
    ctx.stroke(boxes);
    ctx.strokeStyle = "#ffda68";
    ctx.lineWidth = 1.5;
    ctx.stroke(boxes);
    ctx.restore();
  }
  ctx.restore();
  drawVerticalRoll(ctx, top, viewHeight, scaleY);
  thumbnailCursor.style.left = thumbnailLeft + "px";
  thumbnailCursor.style.top = matrixTop + "px";
  thumbnailCursor.style.width = thumbnailWidth + "px";
  thumbnailCursor.style.height = viewHeight + "px";
  ctx.font = "11px Segoe UI";
  ctx.fillStyle = plotColors.label;
  const end = result.ticks / result.tpb;
  const axisBottom = matrixTop + viewHeight;
  for (const {beat, major} of beatTicks(end, timelineWidth * matrixView.zoom)) {
    const pos = beat * result.tpb * scale;
    const x = left + pos, y = top + pos;
    const length = major ? 4 : 2;
    ctx.strokeStyle = major ? plotColors.strong : plotColors.line;
    ctx.beginPath();
    if (x >= plotLeft && x <= plotLeft + timelineWidth + 1e-8) {
      ctx.moveTo(x, axisBottom); ctx.lineTo(x, axisBottom - length);
      ctx.textAlign = "center";
      if (major) ctx.fillText(formatter.format(beat), x, axisBottom + 17);
    }
    if (y >= matrixTop && y <= axisBottom + 1e-8) {
      ctx.moveTo(plotLeft - length, y); ctx.lineTo(plotLeft, y);
      ctx.textAlign = "right";
      if (major) ctx.fillText(formatter.format(beat), plotLeft - 7, y + 4);
    }
    ctx.stroke();
  }
  ctx.textAlign = "right";
  ctx.fillText("A 拍", width - 9, height - 7);
  ctx.textAlign = "left";
  ctx.fillText("B 拍", 5, height - 7);
  drawOverlay();
  drawThumbnailHighlights();
}
function clipMatrix(ctx) {
  ctx.beginPath();
  ctx.rect(plotLeft, matrixTop, geometry.timelineWidth, geometry.viewHeight);
  ctx.clip();
}
function drawVerticalRoll(ctx, top, height, scale) {
  const left = thumbnailLeft, width = thumbnailWidth;
  const pitchScale = width / result.pitches;
  ctx.fillStyle = plotColors.chart;
  ctx.fillRect(left, matrixTop, width, height);
  ctx.save();
  ctx.beginPath(); ctx.rect(left, matrixTop, width, height); ctx.clip();
  ctx.fillStyle = "#dfd9ff";
  for (const [on, off, pitch] of result.notes) {
    const x = left + (pitch - result.pitchStart) * pitchScale;
    ctx.fillRect(x, top + on * scale, Math.max(1, pitchScale - .25), Math.max(1, (off - on) * scale));
  }
  ctx.restore();
}
function drawThumbnailHighlights() {
  if (!geometry || !result) return;
  const {ctx, width, height} = canvasContext(thumbnailCursor);
  const tickToY = (tick) => geometry.top - matrixTop + tick * geometry.scaleY;
  ctx.globalAlpha = .32;
  for (const {start, end, color} of treeLevelHighlight.ranges) shade([start, end], color);
  ctx.globalAlpha = 1;
  function shade(bounds, color) {
    if (!bounds) return;
    const [start, end] = bounds;
    ctx.fillStyle = color;
    ctx.fillRect(0, tickToY(start), width, Math.max(1, (end - start) * geometry.scaleY));
  }
  function marker(tick, color) {
    const y = tickToY(tick);
    if (y < 0 || y >= height) return;
    ctx.fillStyle = color;
    ctx.fillRect(0, Math.max(0, y - .75), width, 1.5);
  }
  const pair = visiblePair();
  shade(pair?.a, colorA + "55");
  shade(pair?.b, colorB + "55");
  if (timelineHover) {
    for (const bounds of timelineHover.related) shade(bounds, colorA + "60");
    shade(timelineHover.bounds, colorB + "70");
  }
  if (cursor) {
    marker((cursor.x + .5) * result.stride, colorA);
    marker((cursor.y + .5) * result.stride, colorB);
  }
  if (playHead !== undefined) marker(playHead, "#fff1aa");
}
function drawOverlapGuide(ctx) {
  const guideStatus = $("overlapStatus");
  const activeLine = hoveredLine ?? selection?.line;
  const original = activeLine && splitSources.get(activeLine.join(","));
  const guideLine = original ?? activeLine;
  const overlap = guideLine ? overlapTicks(guideLine, result.stride) : 0;
  guideStatus.hidden = overlap === 0;
  if (overlap === 0) return;
  const half = result.stride / 2;
  const start = guideLine[2] - half, end = guideLine[1] + half;
  const message = (original ? "原斜线重叠 " : "重叠 ") + strideLabel(overlap / result.tpb) + " 拍" +
    (original ? " · 首次截断在 B " + coordinateFormatter.format(start / result.tpb) + " 拍" : "");
  if (guideStatus.textContent !== message) guideStatus.textContent = message;
  const {left, top, scale, scaleY} = geometry;
  const startX = left + start * scale, endX = left + end * scale;
  const startY = top + start * scaleY, endY = top + end * scaleY;
  ctx.save();
  ctx.fillStyle = "#f2b8cb";
  ctx.strokeStyle = "#a62e55";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.lineTo(startX, endY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const firstY = top + (guideLine[0] - half) * scaleY;
  const lastX = left + (guideLine[3] + half) * scale;
  const cutX = startX + (guideLine[2] - guideLine[0]) * scale;
  ctx.lineWidth = 1.7;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#ff718d";
  ctx.beginPath();
  ctx.moveTo(startX, firstY); ctx.lineTo(startX, startY);
  ctx.moveTo(endX, endY); ctx.lineTo(lastX, endY);
  ctx.stroke();
  ctx.strokeStyle = "#fbd259";
  ctx.beginPath();
  ctx.moveTo(startX, startY); ctx.lineTo(cutX, startY);
  ctx.stroke();
  ctx.restore();
}
function traceMatch(ctx, [x0, x1, y0, y1]) {
  const {left, top, scale, scaleY, cellX} = geometry;
  const half = x0 === x1 ? Math.min(2, cellX * .28) : 0;
  ctx.moveTo(left + y0 * scale - half, top + x0 * scaleY - half);
  ctx.lineTo(left + y1 * scale + half, top + x1 * scaleY + half);
}
function shortMatchDash() {
  const dash = Math.max(1.5, Math.min(5, geometry.cellX * .65));
  return [dash, dash * .65];
}
function drawBaseMatches(ctx) {
  ctx.save();
  const width = Math.max(1.55, Math.min(2.45, geometry.cellX * .65));
  for (const group of [
    {lines: shortLines, width: width * .8, dash: shortMatchDash(), colors: ["#c2c7f58a", "#ff8ba68f"]},
    {lines: shownLines, width, dash: [], colors: ["#76f0e0b0", "#ff718dc0"]},
  ]) {
    ctx.lineWidth = group.width;
    ctx.setLineDash(group.dash);
    for (const [index, color] of group.colors.entries()) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const line of group.lines) {
        if ((overlapTicks(line, result.stride) > 0) === Boolean(index)) traceMatch(ctx, line);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}
function drawActiveMatch(ctx, line, color, showOverlap = true) {
  const {left, top, cellX, cellY} = geometry;
  const stride = result.stride;
  const rowStart = Math.round(line[0] / stride - .5);
  const columnStart = Math.round(line[2] / stride - .5);
  const length = Math.round((line[1] - line[0]) / stride) + 1;
  const accent = showOverlap && overlapTicks(line, stride) > 0 ? "#ff718d" : color;
  ctx.fillStyle = accent;
  ctx.globalAlpha = .52;
  for (let i = 0; i < length; i++) {
    ctx.fillRect(left + (columnStart + i) * cellX, top + (rowStart + i) * cellY, cellX, cellY);
  }
  ctx.strokeStyle = accent;
  ctx.globalAlpha = .85;
  ctx.lineWidth = Math.max(1.25, Math.min(3.5, cellX * .65));
  if (shortLines.has(line)) ctx.setLineDash(shortMatchDash());
  ctx.beginPath();
  traceMatch(ctx, line);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}
function drawOverlay() {
  const {ctx} = canvasContext(outline);
  if (!result || !geometry) return;
  const {left, top, spanY, cellX, cellY, scale, scaleY} = geometry;
  ctx.save();
  clipMatrix(ctx);
  if (treeLevelHighlight.ranges.length || timelineHover) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(left, top); ctx.lineTo(left + spanY, top); ctx.lineTo(left + spanY, top + spanY);
    ctx.closePath(); ctx.clip();
    ctx.globalAlpha = .16;
    for (const {start, end, color} of treeLevelHighlight.ranges) {
      ctx.fillStyle = color;
      ctx.fillRect(left, top + start * scaleY, spanY, Math.max(1, (end - start) * scaleY));
      ctx.fillRect(left + start * scale, top, Math.max(1, (end - start) * scale), spanY);
    }
    ctx.globalAlpha = 1;
    if (timelineHover) {
      const {bounds: [start, end]} = timelineHover;
      ctx.fillStyle = colorB + "59";
      ctx.fillRect(left, top + start * scaleY, spanY, (end - start) * scaleY);
      ctx.fillStyle = colorA + "50";
      ctx.fillRect(left + start * scale, top, (end - start) * scale, spanY);
    }
    ctx.restore();
  }
  const activeMatches = new Map();
  for (const match of selection?.node?.lines ?? []) activeMatches.set(match, colorA);
  if (selection?.line) activeMatches.set(selection.line, colorA);
  for (const match of timelineHover?.lines ?? []) activeMatches.set(match, "#fce29f");
  if (hoveredLine) activeMatches.set(hoveredLine, "#fce29f");
  if (hoveredRectangle >= 0) {
    ctx.strokeStyle = "#fff1ad";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(...rectanglePixels(result.rectangles[hoveredRectangle]));
    for (const match of rectangleMatches) activeMatches.set(match, "#fff1ad");
  }
  for (const [match, color] of treeLevelHighlight.lines) {
    if (!activeMatches.has(match)) drawActiveMatch(ctx, match, color, false);
  }
  for (const [match, color] of activeMatches) drawActiveMatch(ctx, match, color);
  drawOverlapGuide(ctx);
  if (cursor) {
    const x = left + (cursor.x + .5) * cellX, y = top + (cursor.y + .5) * cellY;
    ctx.lineWidth = 1;
    ctx.strokeStyle = colorB + "c0";
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(x, y); ctx.stroke();
    ctx.strokeStyle = colorA + "c0";
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, top); ctx.stroke();
    ctx.strokeStyle = colorA;
    const w = Math.max(cellX, 5), h = Math.max(cellY, 4);
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
  }
  ctx.restore();
}
function drawPianoRoll(element, pair, segments = []) {
  const {ctx, width, height} = canvasContext(element);
  if (!result) return;
  const left = plotLeft, top = 8, bottom = 21;
  const chartWidth = Math.max(1, width - left - plotRight), chartHeight = height - top - bottom;
  const geometry = {left, top, chartWidth, chartHeight};
  const pitchHeight = chartHeight / result.pitches;
  const x = (tick) => left + tick / result.ticks * chartWidth;
  const y = (pitch) => top + (result.pitchStart + result.pitches - pitch - 1) * pitchHeight;
  ctx.font = "10px Segoe UI";
  ctx.fillStyle = plotColors.chartMuted;
  for (const {beat, major} of beatTicks(result.ticks / result.tpb, chartWidth)) {
    const position = x(beat * result.tpb);
    ctx.strokeStyle = major ? plotColors.chartGridStrong : plotColors.chartGrid;
    ctx.beginPath(); ctx.moveTo(position, top); ctx.lineTo(position, height - bottom); ctx.stroke();
    ctx.textAlign = "center";
    if (major) ctx.fillText(formatter.format(beat), position, height - 7);
  }
  ctx.textAlign = "right";
  const lowPitch = result.pitchStart, highPitch = lowPitch + result.pitches - 1;
  for (const pitch of new Set([lowPitch, highPitch])) ctx.fillText(pitch, left - 5, Math.min(height - bottom, Math.max(top + 8, y(pitch) + pitchHeight * .5)));
  if (pair && !pair.node) {
    for (const [bounds, color] of [[pair.a, colorA], [pair.b, colorB]]) {
      if (!bounds) continue;
      ctx.fillStyle = color + "44";
      ctx.fillRect(x(bounds[0]), top, x(bounds[1]) - x(bounds[0]), chartHeight);
    }
  }
  ctx.fillStyle = "#dfd9ff";
  for (const [on, off, pitch] of result.notes) {
    ctx.fillRect(x(on), y(pitch), Math.max(1, x(off) - x(on)), Math.max(1, pitchHeight - .6));
  }
  if (pair?.node) drawRollBox(ctx, geometry, nodeRollBox(pair.node), colorA);
  for (const {box, color, categoryId} of segments) {
    drawRollBox(ctx, geometry, box, color, categoryId);
  }
  return geometry;
}

function drawRollBox(ctx, {left, top, chartWidth, chartHeight}, box, color, label) {
  if (!box) return;
  const [start, low, end, high] = box;
  const pitchHeight = chartHeight / result.pitches;
  const x = left + start / result.ticks * chartWidth;
  const y = top + (result.pitchStart + result.pitches - high) * pitchHeight;
  const width = Math.max(2, (end - start) / result.ticks * chartWidth);
  const height = (high - low) * pitchHeight;
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.globalAlpha = .16;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, width, height);
  ctx.lineWidth = 1;
  if (label && width > ctx.measureText(label).width + 5) {
    ctx.textAlign = "left";
    ctx.fillText(label, x + 3, Math.max(10, y - 2));
  }
}

function drawRoll() {
  rollGeometry = drawPianoRoll(roll, visiblePair());
  drawRollCursor();
}
function drawPlayhead(element, geometry) {
  if (!geometry) return;
  const {ctx} = canvasContext(element);
  if (playHead !== undefined) {
    const {left, top, chartWidth, chartHeight} = geometry;
    const x = left + playHead / result.ticks * chartWidth;
    ctx.strokeStyle = "#fff1aa";
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + chartHeight); ctx.stroke();
  }
}
function drawEverything() {
  if (!result) return;
  const wrap = canvas.parentElement;
  const axes = matrixTop + matrixBottom - plotLeft - plotRight;
  const cssHeight = (wrap.getBoundingClientRect().width + axes) + "px";
  if (wrap.style.height !== cssHeight) wrap.style.height = cssHeight;
  drawTree();
  drawRoll();
  drawAnnotation();
  drawMetricHistory();
  drawMatrix();
}

function drawAnnotation() {
  $("annotationPanel").hidden = !annotationView;
  if (!annotationView) {
    renderedAnnotation = annotationGeometry = null;
    return;
  }
  const chart = $("annotationTree");
  const width = chart.clientWidth;
  if (!width || (renderedAnnotation === annotationView && annotationWidth === width && annotationColors === plotColors)) return;
  renderedAnnotation = annotationView;
  annotationWidth = width;
  annotationColors = plotColors;
  const {layers, selected} = annotationView;
  const entries = layers.flatMap(({segments}, rank) => segments.map((segment) => ({
    item: {start: segment.box[0], end: segment.box[2]},
    segment, rank, parents: [],
  })));
  const root = entries.length;
  const byId = new Map(entries.map(({segment}, index) => [segment.id, index]));
  for (const [index, {segment, rank}] of entries.entries()) {
    for (const id of segment.sourceWordIds ?? []) {
      const child = entries[byId.get(id)];
      if (child && child.rank < rank) child.parents.push(index);
    }
  }
  const candidates = new Map();
  for (const [index, {segment}] of entries.entries()) {
    for (const id of segment.noteIds) {
      if (!candidates.has(id)) candidates.set(id, []);
      candidates.get(id).push(index);
    }
  }
  const memberships = entries.map(({segment}) => new Set(segment.noteIds));
  for (const entry of entries) {
    if (entry.parents.length) continue;
    const parent = candidates.get(entry.segment.noteIds[0]).find((index) =>
      entries[index].rank > entry.rank && entry.segment.noteIds.every((id) => memberships[index].has(id)));
    entry.parents.push(parent ?? root);
  }
  entries.push({item: {start: 0, end: result.ticks}, rank: layers.length, parents: []});
  const layout = placeTreeEntries(entries, width);
  chart.style.height = layout.height + "px";
  const content = document.createDocumentFragment();
  for (const {rank, top} of layout.rulers) {
    const label = document.createElement("span");
    label.className = "annotation-level-label";
    label.textContent = layers[rank]?.name ?? "整条音轨";
    label.title = label.textContent;
    label.style.top = top + "px";
    content.append(label);
  }
  for (const {item, segment, left, width, top} of layout.entries) {
    const node = document.createElement(segment ? "button" : "span");
    const label = segment?.categoryLabel || segment?.categoryId || "整条音轨";
    node.className = "tree-node";
    node.classList.toggle("is-narrow", width < 8);
    node.style.left = left + "px";
    node.style.width = Math.max(2, width) + "px";
    node.style.top = top + "px";
    node.style.setProperty("--node-edge", segment?.color ?? fixedTreeColors.root);
    node.style.setProperty("--node-fill", "color-mix(in srgb, var(--node-edge) 35%, var(--surface))");
    node.textContent = width >= 20 ? label : "";
    node.title = label + " · " + interval([item.start, item.end]);
    if (segment) {
      node.type = "button";
      node.setAttribute("aria-label", node.title);
      node.addEventListener("click", () => playAnnotation(segment));
    }
    content.append(node);
  }
  chart.querySelector(".annotation-tree-nodes").replaceChildren(content);
  drawTreeLinks(chart.querySelector(".annotation-tree-links"), layout);
  const layer = layers[selected];
  text("annotationRollLayer", layer?.name ?? "");
  annotationGeometry = drawPianoRoll(annotationRoll, null, layer?.segments);
  drawPlayhead($("annotationPlayhead"), annotationGeometry);
}

function drawRollCursor() {
  drawThumbnailHighlights();
  const {ctx} = canvasContext(rollCursor);
  if (!rollGeometry || !result) return;
  const {left, top, chartWidth, chartHeight} = rollGeometry;
  const pixel = chartWidth / result.ticks;
  for (const {box, color} of treeLevelHighlight.ranges) {
    drawRollBox(ctx, rollGeometry, box, color);
  }
  if (playHead !== undefined) {
    const x = left + playHead * pixel;
    ctx.strokeStyle = "#fff1aa";
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + chartHeight); ctx.stroke();
  }
  if (timelineHover?.node) {
    for (const box of timelineHover.relatedBoxes) drawRollBox(ctx, rollGeometry, box, colorA);
    drawRollBox(ctx, rollGeometry, nodeRollBox(timelineHover.node), colorB);
  } else if (timelineHover) {
    for (const [start, end] of timelineHover.related) {
      ctx.fillStyle = colorA + "60";
      ctx.fillRect(left + start * pixel, top, Math.max(1, (end - start) * pixel), chartHeight);
    }
    const [start, end] = timelineHover.bounds;
    const x = left + start * pixel, span = Math.max(2, (end - start) * pixel);
    ctx.fillStyle = colorB + "66";
    ctx.fillRect(x, top, span, chartHeight);
    ctx.strokeStyle = colorB;
    ctx.strokeRect(x, top + .5, span, chartHeight - 1);
  }
  if (!cursor) return;
  const width = result.stride * chartWidth / result.ticks;
  ctx.font = "bold 11px Segoe UI";
  for (const [label, index, color, labelOffset] of [["A", cursor.x, colorA, 0], ["B", cursor.y, colorB, 16]]) {
    const start = left + width * index;
    const position = start + width / 2;
    ctx.fillStyle = color + "42";
    ctx.fillRect(start, top, width, chartHeight);
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(position, top); ctx.lineTo(position, top + chartHeight); ctx.stroke();
    const labelX = Math.min(position + 3, left + chartWidth - 15);
    ctx.fillStyle = color;
    ctx.fillRect(labelX, top + labelOffset, 15, 15);
    ctx.fillStyle = plotColors.chart;
    ctx.fillText(label, labelX + 4, top + labelOffset + 11);
  }
}
function matrixPoint(event) {
  if (!result || !geometry) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left - plotLeft;
  const y = event.clientY - rect.top - matrixTop;
  if (x < 0 || y < 0 || x >= geometry.timelineWidth || y >= geometry.viewHeight) return null;
  return {x, y};
}
function cellAt(event) {
  const point = matrixPoint(event);
  if (!point) return null;
  const px = point.x + plotLeft - geometry.left;
  const py = point.y + matrixTop - geometry.top;
  const x = Math.floor(px / geometry.cellX), y = Math.floor(py / geometry.cellY);
  if (x < 0 || y < 0 || x >= result.size || y >= result.size) return null;
  return {x, y, px, py};
}
function nearestLine(cell) {
  if (!cell) return null;
  const {scale, scaleY, cellX, cellY} = geometry;
  let px = cell.px ?? (cell.x + .5) * cellX;
  let py = cell.py ?? (cell.y + .5) * cellY;
  // The blank half mirrors pointer coordinates into the plotted triangle.
  if (cell.y > cell.x) [px, py] = [py, px];
  let closest = null, best = 7 ** 2;
  for (const line of selectableLines) {
    const x = line[2] * scale, y = line[0] * scaleY;
    const dx = (line[3] - line[2]) * scale, dy = (line[1] - line[0]) * scaleY;
    const lengthSquared = dx ** 2 + dy ** 2;
    const fraction = lengthSquared ? Math.max(0, Math.min(1, ((px - x) * dx + (py - y) * dy) / lengthSquared)) : 0;
    const distance = (px - x - fraction * dx) ** 2 + (py - y - fraction * dy) ** 2;
    if (distance < best) {
      closest = line;
      best = distance;
    }
  }
  return closest;
}
function shortMatchDescription(line) {
  const count = Math.round((line[1] - line[0]) / result.stride) + 1;
  return "短斜线 " + beat(count * result.stride) + " 拍 · 至少需要 " + beat(minimumLineCells(result) * result.stride) + " 拍";
}
function rectangleAt(cell) {
  if (!showRectangles || !cell || !result.rectangles?.length) return -1;
  const {left, top, cellX, cellY} = geometry;
  const px = left + (cell.px ?? (cell.x + .5) * cellX);
  const py = top + (cell.py ?? (cell.y + .5) * cellY);
  let hit = -1, nearestEdge = 4, smallestArea = Infinity;
  for (const [index, rectangle] of result.rectangles.entries()) {
    const [x, y, width, height] = rectanglePixels(rectangle);
    const dx = Math.min(px - x, x + width - px);
    const dy = Math.min(py - y, y + height - py);
    if (dx < -nearestEdge || dy < -nearestEdge) continue;
    const distance = Math.abs(Math.min(dx, dy));
    const area = width * height;
    if (distance < nearestEdge || (distance === nearestEdge && area < smallestArea)) {
      hit = index;
      nearestEdge = distance;
      smallestArea = area;
    }
  }
  return hit;
}
function updateRectangleHover() {
  const index = rectangleAt(cursor);
  if (index === hoveredRectangle) return;
  hoveredRectangle = index;
  rectangleMatches = [];
  if (index < 0) return;
  const [col, row, cols, rows] = result.rectangles[index];
  const stride = result.stride;
  rectangleMatches = selectableLines.filter(([x0, x1, y0]) => {
    const startCol = Math.floor(x0 / stride), startRow = Math.floor(y0 / stride);
    const first = Math.max(0, col - startCol, row - startRow);
    return startCol + first <= Math.floor(x1 / stride) &&
      startCol + first < col + cols && startRow + first < row + rows;
  });
}
function showMatrixTooltip(a, b, score, filtered, reflected) {
  matrixTooltip.hidden = false;
  text("tooltipA", "A " + a);
  text("tooltipB", "B " + b);
  text("tooltipScore", (reflected ? "镜像相似度 " : "相似度 ") + score);
  $("tooltipFilter").hidden = !filtered;
  text("tooltipFilter", filtered ? "低于阈值 · 已过滤" : "");
  const short = shortLines.has(hoveredLine);
  $("tooltipMatch").hidden = !short;
  if (short) text("tooltipMatch", shortMatchDescription(hoveredLine));
  const overRectangle = hoveredRectangle >= 0;
  $("tooltipRectangleSize").hidden = $("tooltipRectangleRemoved").hidden = !overRectangle;
  if (overRectangle) {
    const [, , cols, rows] = result.rectangles[hoveredRectangle];
    const side = (cells) => coordinateFormatter.format(cells * result.stride / result.tpb);
    text("tooltipRectangleSize", "矩形 · 宽 " + side(rows) + " 拍 · 高 " + side(cols) + " 拍");
    text("tooltipRectangleRemoved", "框内去重 " + (result.rectangleRemovedCounts?.[hoveredRectangle] ?? 0) + " 条斜线");
  }
  const {left, top} = canvas.getBoundingClientRect();
  const x = left + geometry.left + (cursor.px ?? (cursor.x + .5) * geometry.cellX);
  const y = top + geometry.top + (cursor.py ?? (cursor.y + .5) * geometry.cellY);
  const width = matrixTooltip.offsetWidth, height = matrixTooltip.offsetHeight;
  const preferredX = x + 14 + width <= innerWidth - 8 ? x + 14 : x - width - 14;
  const preferredY = y + 12 + height <= innerHeight - 8 ? y + 12 : y - height - 12;
  matrixTooltip.style.left = Math.max(8, Math.min(innerWidth - width - 8, preferredX)) + "px";
  matrixTooltip.style.top = Math.max(8, Math.min(innerHeight - height - 8, preferredY)) + "px";
}
function showCell() {
  if (!result) return;
  const reflected = cursor?.y > cursor?.x;
  const before = hoveredLine, wasMirrored = mirroredHover;
  updateRectangleHover();
  hoveredLine = hoveredRectangle >= 0 ? null : nearestLine(cursor);
  mirroredHover = reflected;
  const value = cursor ? matrix[Math.max(cursor.x, cursor.y) * result.size + Math.min(cursor.x, cursor.y)] : undefined;
  if (!Number.isFinite(value)) matrixTooltip.hidden = true;
  if (Number.isFinite(value)) {
    const startBeat = (frame) => coordinateFormatter.format(frame * result.stride / result.tpb) + " 拍";
    const a = startBeat(cursor.x), b = startBeat(cursor.y), score = value.toFixed(3);
    const filtered = !showRawMatrix && value < result.config.threshold;
    text("cell", "A " + a + " · B " + b + (reflected ? " · 镜像相似度 " : " · 相似度 ") + score + (filtered ? " · 低于阈值" : ""));
    showMatrixTooltip(a, b, score, filtered, reflected);
  } else if (timelineHover) {
    const label = timelineHover.node?.label ?? "卷帘";
    text("cell", label + " · " + interval(timelineHover.bounds) + " · " + timelineHover.lines.size + " 条匹配斜线");
  } else {
    text("cell", cellHint);
  }
  if (before !== hoveredLine || (hoveredLine && wasMirrored !== mirroredHover)) {
    updateAuditionButtons();
    drawRoll();
  }
  markTreeSelection();
  canvas.classList.toggle("near-match", Boolean(hoveredLine) && !mirroredHover);
  canvas.classList.toggle("crosshair", Boolean(cursor));
  drawOverlay();
  drawRollCursor();
}
function pairFromLine(line) {
  const [x0, x1, y0, y1] = line;
  const half = result.stride / 2;
  return {a: [y0 - half, y1 + half], b: [x0 - half, x1 + half], line};
}
function frameBounds(frame) {
  const start = frame * result.stride;
  return [start, Math.min(start + result.stride, result.ticks)];
}
function treeInterval(node) {
  return [node.start, node.end];
}

function rollNotesBox(start, end) {
  let first = 0, last = rollNotesByOnset.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (rollNotesByOnset[middle][0] < start) first = middle + 1;
    else last = middle;
  }
  if (first === rollNotesByOnset.length || rollNotesByOnset[first][0] >= end) return null;

  const left = rollNotesByOnset[first][0];
  let right = left, low = Infinity, high = -Infinity;
  // Use the same onset-based membership as the structure comparison.
  for (let index = first; index < rollNotesByOnset.length; index++) {
    const [on, off, pitch] = rollNotesByOnset[index];
    if (on >= end) break;
    right = Math.max(right, off, on + 1);
    low = Math.min(low, pitch);
    high = Math.max(high, pitch + 1);
  }
  return [left, low, Math.min(right, result.ticks), high];
}

function nodeRollBox(node) {
  if (node.rollBox === undefined) node.rollBox = rollNotesBox(node.start, node.end);
  return node.rollBox;
}

function overlap(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}
function highlightTimeline(bounds, {frame, node} = {}) {
  const lines = new Set(), related = new Map();
  const matchBounds = node?.matchBounds ?? bounds;
  for (const line of node ? node.lines : shownLines) {
    const {a, b} = pairFromLine(line);
    for (const [here, other] of [[a, b], [b, a]]) {
      if (node ? here[0] !== matchBounds[0] || here[1] !== matchBounds[1] : !overlap(here, bounds)) continue;
      lines.add(line);
      const match = node ? other : [other[0] + bounds[0] - here[0], other[0] + bounds[1] - here[0]];
      related.set(match[0] + "," + match[1], match);
    }
  }
  cursor = null;
  timelineHover = {bounds, frame, node, lines, related: [...related.values()]};
  if (node) timelineHover.relatedBoxes = timelineHover.related.map(([start, end]) => rollNotesBox(start, end));
  showCell();
}
function clearTimelineHover() {
  if (!timelineHover) return;
  timelineHover = null;
  showCell();
}
function selectCell(cell) {
  if (!cell || cell.y > cell.x) return;
  const line = nearestLine(cell);
  if (line) {
    choose(pairFromLine(line));
    return;
  }
  const {stride} = result;
  choose({a: [cell.x * stride, (cell.x + 1) * stride], b: [cell.y * stride, (cell.y + 1) * stride]});
}
function visiblePair() {
  if (!hoveredLine) return selection;
  const pair = pairFromLine(hoveredLine);
  return mirroredHover ? {...pair, a: pair.b, b: pair.a} : pair;
}
function choose(pair) {
  selection = pair;
  updateAuditionButtons();
  drawRoll();
  drawOverlay();
  markTreeSelection();
}
function updateAuditionButtons() {
  const pair = visiblePair();
  $("playA").disabled = !pair?.a;
  $("playB").disabled = !pair?.b;
}

function buildTreeItems(nodes) {
  const linked = new Map(), classes = new Map();
  for (const line of shownLines) {
    const {a, b} = pairFromLine(line);
    for (const key of [a.join(","), b.join(",")]) {
      if (!linked.has(key)) linked.set(key, []);
      linked.get(key).push(line);
    }
  }
  const items = [];
  for (const node of nodes) {
    const {parent} = node;
    const label = {root: "完整音轨", unique: "独有片段", fill: "补齐片段"}[node.class];
    if (label) {
      items.push({...node, parent, label, color: fixedTreeColors[node.class], classIndex: -1, lines: []});
      continue;
    }
    if (!classes.has(node.class)) classes.set(node.class, classes.size + 1);
    const classIndex = classes.get(node.class);
    const key = (node.matchBounds ?? [node.start, node.end]).join(",");
    const lines = linked.get(key) ?? [];
    const color = treeClassColors[classIndex - 1] ?? `hsl(${classIndex * 137.508 % 360} 68% 64%)`;
    items.push({...node, parent, label: "相似类 " + classIndex, color, classIndex, lines});
  }
  return items;
}
function layoutTree(width) {
  // Parents precede children in the analysis response.
  const ranks = new Uint32Array(treeItems.length);
  for (let index = treeItems.length - 1; index >= 0; index--) {
    const {parent} = treeItems[index];
    if (parent !== null) ranks[parent] = Math.max(ranks[parent], ranks[index] + 1);
  }
  const entriesByIndex = [];
  function addEntry(item, rank, parent) {
    const entry = {item, rank, parent};
    entriesByIndex.push(entry);
    return entry;
  }
  for (const [index, item] of treeItems.entries()) addEntry(item, ranks[index], item.parent);
  if (padTreeParents) {
    for (const [index, item] of treeItems.entries()) {
      if (item.parent === null) continue;
      const parent = entriesByIndex[item.parent];
      let child = entriesByIndex[index];
      // Each skipped row shows the same segment. Only the display links change.
      for (let rank = child.rank + 1; rank < parent.rank; rank++) {
        child.parent = entriesByIndex.length;
        child = addEntry(item, rank, item.parent);
      }
    }
  }
  return placeTreeEntries(entriesByIndex, width);
}
function placeTreeEntries(entries, width) {
  const scale = Math.max(1, width - plotLeft - plotRight) / result.ticks;
  const levels = new Map();
  for (const entry of entries) {
    const {item, rank} = entry;
    entry.left = plotLeft + item.start * scale;
    entry.width = (item.end - item.start) * scale;
    if (!levels.has(rank)) levels.set(rank, []);
    levels.get(rank).push(entry);
  }
  const laneHeight = treeNodeHeight + 4;
  const rulers = [];
  let top = 25;
  for (const [rank, entries] of [...levels].sort(([a], [b]) => b - a)) {
    const ends = [];
    const placed = entries.sort((a, b) => a.left - b.left || b.width - a.width);
    for (const entry of placed) {
      let lane = ends.findIndex((end) => end <= entry.item.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = entry.item.end;
      entry.lane = lane;
    }
    const baseline = top + (ends.length - 1) * laneHeight;
    for (const entry of placed) entry.top = baseline - entry.lane * laneHeight;
    rulers.push({rank, top: baseline});
    top += ends.length * laneHeight + 9;
  }
  return {entries, rulers, height: top};
}
function drawTree() {
  const chart = $("treeChart");
  const width = chart.clientWidth;
  if (width === treeWidth || !width) return;
  treeWidth = width;
  treeButtons.clear();
  treeLevelButtons.clear();
  hoveredTreeLevel = null;
  const layout = layoutTree(width);
  chart.style.height = layout.height + "px";
  const fills = ["#d9dcfa", "#caeee7", "#f1ddc5", "#ead6ef", "#d5e6fa", "#f0deac"];
  const edges = ["#9d9bd4", "#7abdb0", "#c5a278", "#ba90c3", "#8daace", "#bba148"];
  const fragment = document.createDocumentFragment();
  for (const {rank, top} of layout.rulers) {
    const button = document.createElement("button");
    button.className = "tree-level";
    button.type = "button";
    button.style.top = top + "px";
    button.textContent = "L" + rank;
    button.title = "高亮 L" + rank + " 层全部节点";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      hoveredTreeLevel = rank;
      markTreeLevel();
    });
    button.addEventListener("pointerleave", () => {
      if (hoveredTreeLevel !== rank) return;
      hoveredTreeLevel = null;
      markTreeLevel();
    });
    button.addEventListener("click", () => {
      pinnedTreeLevel = pinnedTreeLevel === rank ? null : rank;
      markTreeLevel();
    });
    treeLevelButtons.set(rank, button);
    fragment.append(button);
  }
  for (const entry of layout.entries) {
    const {item, rank, left, width, top} = entry;
    const button = document.createElement("button");
    button.className = "tree-node";
    button.classList.toggle("is-narrow", width < 8);
    button.type = "button";
    button.style.left = left + "px";
    button.style.width = width + "px";
    button.style.top = top + "px";
    const color = (item.classIndex - 1) % fills.length;
    button.style.setProperty("--node-edge", edges[color] ?? "#a8a5b8");
    button.style.setProperty("--node-fill", fills[color] ?? "#e1dfea");
    button.style.setProperty("--level-color", item.color);
    const label = item.label + " · " + interval([item.start, item.end]);
    button.title = label + " · 层级 L" + rank + " · " + item.lines.length + " 条匹配斜线";
    button.setAttribute("aria-label", button.title);
    button.textContent = width >= 45 ? item.label : "";
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") highlightTimeline(treeInterval(item), {node: item});
    });
    button.addEventListener("pointerleave", () => {
      if (timelineHover?.node === item) clearTimelineHover();
    });
    button.addEventListener("click", () => {
      const bounds = treeInterval(item);
      choose({a: bounds, node: item});
      play(bounds);
    });
    treeButtons.set(entry, button);
    fragment.append(button);
  }
  $("treeNodes").replaceChildren(fragment);
  markTreeSelection();
  markTreeLevel();
  drawTreeLinks($("treeLinks"), layout);
}
function markTreeLevel() {
  const active = hoveredTreeLevel ?? pinnedTreeLevel;
  const ranges = new Map(), lines = new Map();
  for (const [rank, button] of treeLevelButtons) {
    button.classList.toggle("is-active", rank === active);
    button.setAttribute("aria-pressed", String(rank === pinnedTreeLevel));
  }
  for (const [entry, button] of treeButtons) {
    const {item, rank} = entry;
    button.classList.toggle("is-level-highlighted", rank === active);
    if (rank !== active) continue;
    const [left, right] = treeInterval(item);
    const start = Math.max(0, left), end = Math.min(result.ticks, right);
    if (start < end) {
      ranges.set(`${start},${end},${item.class}`, {start, end, box: nodeRollBox(item), color: item.color});
    }
    for (const line of item.lines) lines.set(line, item.color);
  }
  treeLevelHighlight = {ranges: [...ranges.values()], lines};
  drawRollCursor();
  drawOverlay();
}
function markTreeSelection() {
  const guide = $("treeCursor");
  const ranges = cursor ? [frameBounds(cursor.x), frameBounds(cursor.y)] :
    timelineHover && !timelineHover.node ? [timelineHover.bounds] : [];
  const width = Math.max(1, guide.clientWidth - plotLeft - plotRight);
  const pixelsPerTick = width / result.ticks;
  guide.replaceChildren(...ranges.map(([start, end], index) => {
    const marker = document.createElement("span");
    marker.style.left = plotLeft + start * pixelsPerTick + "px";
    marker.style.width = Math.max(2, (end - start) * pixelsPerTick) + "px";
    marker.style.background = (index ? colorB : colorA) + "65";
    return marker;
  }));
  for (const [{item}, button] of treeButtons) {
    const selected = selection?.node === item || (selection?.line && item.lines.includes(selection.line));
    const pressed = String(Boolean(selected));
    if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    const linked = timelineHover?.node === item || item.lines.some(line => line === hoveredLine || timelineHover?.lines.has(line)) ||
      (item.class !== "root" && ranges.some(range => overlap(treeInterval(item), range)));
    button.classList.toggle("is-linked", linked);
  }
}
function drawTreeLinks(layer, {height: chartHeight, entries}) {
  const chartWidth = layer.clientWidth - plotLeft - plotRight;
  const ticks = beatTicks(result.ticks / result.tpb, chartWidth);
  // Split tall trees so their connection layer stays within canvas height limits.
  const tileHeight = Math.max(1, Math.floor(4096 / (window.devicePixelRatio || 1)));
  const tiles = [];
  const fragment = document.createDocumentFragment();
  for (let offset = 0; offset < chartHeight; offset += tileHeight) {
    const tile = document.createElement("canvas");
    tile.style.height = Math.min(tileHeight, chartHeight - offset) + "px";
    tiles.push({tile, offset});
    fragment.append(tile);
  }
  layer.replaceChildren(fragment);
  for (const {tile, offset} of tiles) {
    const {ctx, height} = canvasContext(tile);
    const bottom = offset + height;
    ctx.translate(0, -offset);
    ctx.font = "11px Segoe UI";
    ctx.fillStyle = plotColors.label;
    ctx.textAlign = "center";
    for (const {beat, major} of ticks) {
      const x = plotLeft + beat * result.tpb * chartWidth / result.ticks;
      if (major && offset === 0) ctx.fillText(formatter.format(beat), x, 16);
      ctx.strokeStyle = major ? plotColors.strong : plotColors.line;
      ctx.beginPath();
      ctx.moveTo(x, Math.max(21, offset));
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.strokeStyle = plotColors.strong;
    for (const entry of entries) {
      for (const parentIndex of entry.parents ?? [entry.parent]) {
        const parent = entries[parentIndex];
        if (!parent || entry.top < offset || parent.top + treeNodeHeight > bottom) continue;
        const x0 = parent.left + parent.width / 2, x1 = entry.left + entry.width / 2;
        const y0 = parent.top + treeNodeHeight, y1 = entry.top;
        const middle = (y0 + y1) / 2;
        ctx.beginPath(); ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(x0, middle, x1, middle, x1, y1); ctx.stroke();
      }
    }
  }
}
window.addEventListener("message", (event) => {
  if (event.source === window.parent && event.origin === window.location.origin &&
      event.data?.type === "musicword:deactivate") stopAudio();
});

function stopAudio() {
  audition?.stop();
}
function play([from, to], notes = result.notes) {
  stopAudio();
  text("play", "停止播放");
  audition = previewAudio.play(notes, {
    from, to, tpb: result.tpb,
    onProgress: (tick) => {
      playHead = tick;
      drawRollCursor();
      drawPlayhead($("annotationPlayhead"), annotationGeometry);
    },
    onEnd: () => {
      audition = null;
      playHead = undefined;
      text("play", "播放音轨");
      drawRollCursor();
      drawPlayhead($("annotationPlayhead"), annotationGeometry);
    },
    onError: () => status("浏览器无法播放音符，请重试。", true),
  });
}
function playAnnotation({box: [start, , end], notes}) {
  play([start, end], notes.map(({start, end, pitch}) => [start, end, pitch, 90]));
}
function auditionAt(tick, pitch) {
  const pair = visiblePair();
  const bounds = [pair?.a, pair?.b].find((range) => range && tick >= range[0] && tick < range[1]);
  if (bounds) return play(bounds);
  const note = result.notes.find(([on, off, midi]) => midi === pitch && on <= tick && tick < off);
  if (note) return play(note, [note]);
  const beat = Math.floor(tick / result.tpb) * result.tpb;
  play([beat, Math.min(result.ticks, beat + result.tpb * 4)]);
}
async function exportHtml() {
  $("export").disabled = true;
  try {
    const current = {...result, padTreeParents, annotationView};
    const [template, style, script, preview] = await Promise.all(["./", "./style.css", "./app.js", "./music-preview/offline.html"].map(
      async (url) => { const response = await fetch(url); if (!response.ok) throw new Error(); return response.text(); }
    ));
    const encoded = JSON.stringify(current).replaceAll("<", "\\u003c");
    const close = "</" + "script>";
    const tags = '<script id="embedded" type="application/json">' + encoded + close + "<script>" + script + close;
    const html = template.replace('<link rel="stylesheet" href="style.css">', () => "<style>" + style + "</style>")
      .replace('<script src="music-preview/preview.js" defer>' + close, () => preview)
      .replace('<script src="app.js" defer>' + close, "")
      .replace("</body>", () => tags + "</body>");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([html], {type: "text/html"}));
    link.download = current.name.replace(/[\\/:*?"<>|]/g, "-") + " · SSM.html";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  } catch { status("导出失败，请检查本地工作台是否仍在运行。", true); }
  finally { $("export").disabled = pending; }
}

splitOverlapsButton.addEventListener("click", () => form.elements.splitOverlaps.click());
removeSelfSimilarityButton.addEventListener("click", () => form.elements.removeSelfSimilarity.click());
function setPadTreeParents(value) {
  if (value === padTreeParents) return;
  padTreeParents = value;
  padTreeParentsButton.setAttribute("aria-pressed", String(value));
  if (!result) return;
  if (timelineHover?.node) clearTimelineHover();
  treeWidth = 0;
  drawTree();
}
padTreeParentsButton.addEventListener("click", () => {
  setPadTreeParents(!padTreeParents);
  if (!embedded) markPresetEdited();
});
presetSelect.addEventListener("change", () => {
  loadPreset(presetSelect.value);
  setPresetStatus("");
  queueRecalculation();
});
savePresetButton.addEventListener("click", saveCurrentPreset);
retryStride.addEventListener("click", () => {
  form.elements.stride.value = retryStride.value;
  syncParameterMirrors();
  markPresetEdited();
  queueRecalculation();
});
form.addEventListener("submit", (event) => event.preventDefault());
document.addEventListener("input", ({target}) => {
  if (embedded) return;
  const parameter = target.dataset.param;
  if (parameter) {
    const value = parameter === "stride" ? strideStops[Number(target.value)] : target.value;
    const field = form.elements.namedItem(parameter);
    if (field.type === "checkbox") field.checked = target.checked;
    else field.value = value;
  }
  else if (target.form !== form || !target.name) return;
  if (parameter === "mode" || target === $("mode")) syncMode();
  syncParameterMirrors();
  if (target !== $("track")) markPresetEdited();
  queueRecalculation();
});
function selectExample({ value, selectedOptions }) {
  if (value.startsWith("pop909:")) {
    run({pop909: {id: value.slice("pop909:".length), label: selectedOptions[0].text}});
  } else if (value) run({example: true});
}
$("example").addEventListener("change", (event) => selectExample(event.currentTarget));
previewAudio.attachImport($("file"), (file) => run({file, inspect: true}), (message) => status(message, true));
showRectanglesButton.addEventListener("click", () => {
  showRectangles = !showRectangles;
  showRectanglesButton.setAttribute("aria-pressed", String(showRectangles));
  drawMatrix();
  showCell();
});
rawButton.addEventListener("click", () => {
  showRawMatrix = !showRawMatrix;
  rawButton.setAttribute("aria-pressed", String(showRawMatrix));
  buildHeatmap();
  if (result) { drawMatrix(); showCell(); }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (selection) choose(null);
  if (pinnedTreeLevel !== null || hoveredTreeLevel !== null) {
    hoveredTreeLevel = pinnedTreeLevel = null;
    markTreeLevel();
  }
});
$("play").addEventListener("click", () => audition ? stopAudio() : play([0, result.ticks]));
$("playA").addEventListener("click", () => { const pair = visiblePair(); if (pair) play(pair.a); });
$("playB").addEventListener("click", () => { const pair = visiblePair(); if (pair?.b) play(pair.b); });
$("export").addEventListener("click", exportHtml);
annotationRoll.addEventListener("click", (event) => {
  if (!annotationView || !annotationGeometry) return;
  const {left, top, chartWidth, chartHeight} = annotationGeometry;
  const rect = annotationRoll.getBoundingClientRect();
  const tick = (event.clientX - rect.left - left) / chartWidth * result.ticks;
  const pitch = result.pitchStart + result.pitches - 1 -
    Math.floor((event.clientY - rect.top - top) / chartHeight * result.pitches);
  const segment = annotationView.layers[annotationView.selected]?.segments.find(({box: [start, low, end, high]}) =>
    tick >= start && tick < end && pitch >= low && pitch < high);
  if (segment) playAnnotation(segment);
});
roll.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" || !rollGeometry || !result) return;
  const rect = roll.getBoundingClientRect();
  const fraction = (event.clientX - rect.left - rollGeometry.left) / rollGeometry.chartWidth;
  if (fraction < 0 || fraction >= 1) {
    clearTimelineHover();
    return;
  }
  const frame = Math.floor(fraction * result.ticks / result.stride);
  if (timelineHover?.frame !== frame) highlightTimeline(frameBounds(frame), {frame});
});
roll.addEventListener("pointerleave", clearTimelineHover);
roll.classList.add("mw-playable");
roll.tabIndex = 0;
roll.setAttribute("role", "button");
roll.setAttribute("aria-label", "试听钢琴卷帘，点击可播放片段");
roll.addEventListener("click", (event) => {
  if (!rollGeometry || !result) return;
  const rect = roll.getBoundingClientRect();
  const { left, top, chartWidth, chartHeight } = rollGeometry;
  const time = (event.clientX - rect.left - left) / chartWidth;
  const row = (event.clientY - rect.top - top) / chartHeight;
  if (time < 0 || time >= 1 || row < 0 || row >= 1) return;
  auditionAt(time * result.ticks, result.pitchStart + result.pitches - 1 - Math.floor(row * result.pitches));
});
roll.addEventListener("keydown", (event) => {
  if (!result || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  if (audition) stopAudio();
  else play(selection?.a ?? [0, result.ticks]);
});
resetMatrixButton.addEventListener("click", (event) => {
  finishMatrixDrag();
  Object.assign(matrixView, {zoom: 1, x: 0, y: 0});
  drawMatrix();
  clearCursor();
  if (event.detail === 0) canvas.focus({preventScroll: true});
});
canvas.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  const point = matrixPoint(event);
  if (!point) return;
  event.preventDefault();
  if (!event.deltaY || matrixDrag) return;
  const {zoom, x, y} = matrixView;
  const delta = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY / 100 : event.deltaY;
  const nextZoom = Math.max(1, Math.min(16, zoom * 1.2 ** -delta));
  if (nextZoom === zoom) return;
  const ratio = nextZoom / zoom;
  const offset = (start, anchor) => clampMatrixOffset((start + anchor) * ratio - anchor);
  matrixView.zoom = nextZoom;
  matrixView.x = offset(x, point.x / geometry.timelineWidth);
  matrixView.y = offset(y, point.y / geometry.viewHeight);
  timelineHover = null;
  drawMatrix();
  cursor = cellAt(event);
  showCell();
}, {passive: false});
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  suppressMatrixClick = false;
  if (event.pointerType !== "mouse" || matrixView.zoom <= 1 || !matrixPoint(event)) return;
  matrixDrag = {id: event.pointerId, x: event.clientX, y: event.clientY, active: false};
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (matrixDrag?.id === event.pointerId) {
    const dx = event.clientX - matrixDrag.x, dy = event.clientY - matrixDrag.y;
    if (!matrixDrag.active) {
      if (Math.hypot(dx, dy) < 4) return;
      matrixDrag.active = true;
      suppressMatrixClick = true;
      canvas.classList.add("dragging");
      timelineHover = null;
      clearCursor();
    }
    matrixDrag.x = event.clientX;
    matrixDrag.y = event.clientY;
    const x = clampMatrixOffset(matrixView.x - dx / geometry.timelineWidth);
    const y = clampMatrixOffset(matrixView.y - dy / geometry.viewHeight);
    if (x !== matrixView.x || y !== matrixView.y) {
      matrixView.x = x;
      matrixView.y = y;
      drawMatrix();
    }
    return;
  }
  timelineHover = null;
  cursor = cellAt(event);
  showCell();
});
function finishMatrixDrag(event) {
  if (!matrixDrag || (event && event.pointerId !== matrixDrag.id)) return;
  const {id, active} = matrixDrag;
  matrixDrag = null;
  canvas.classList.remove("dragging");
  if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  if (active && event?.type === "pointerup") {
    cursor = cellAt(event);
    showCell();
  }
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(type, finishMatrixDrag);
}
function clearCursor() { cursor = null; showCell(); }
canvas.addEventListener("pointerleave", clearCursor);
canvas.addEventListener("blur", clearCursor);
canvas.addEventListener("click", (event) => {
  if (suppressMatrixClick) {
    suppressMatrixClick = false;
    return;
  }
  if (geometry && result) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x >= thumbnailLeft && x < thumbnailLeft + thumbnailWidth &&
        y >= matrixTop && y < matrixTop + geometry.viewHeight) {
      const tick = (y - geometry.top) / geometry.scaleY;
      const pitch = result.pitchStart + Math.floor((x - thumbnailLeft) / thumbnailWidth * result.pitches);
      if (tick >= 0 && tick < result.ticks) auditionAt(tick, pitch);
      return;
    }
  }
  cursor = cellAt(event);
  showCell();
  selectCell(cursor);
});
canvas.addEventListener("keydown", (event) => {
  if (!result) return;
  const directions = {ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1]};
  if (event.key === "Enter") {
    event.preventDefault();
    selectCell(cursor ?? {x:0,y:0});
  } else if (Object.hasOwn(directions, event.key)) {
    event.preventDefault();
    const [dx, dy] = directions[event.key];
    const before = cursor ?? {x:0,y:0};
    const x = Math.max(0, Math.min(result.size - 1, before.x + dx));
    const y = Math.max(0, Math.min(result.size - 1, before.y + dy));
    cursor = {x, y};
    if (matrixView.zoom > 1) {
      const {cellX, cellY, timelineWidth, viewHeight} = geometry;
      const follow = (offset, position) => clampMatrixOffset(Math.max(position - .98, Math.min(position - .02, offset)));
      matrixView.x = follow(matrixView.x, (x + .5) * cellX / timelineWidth);
      matrixView.y = follow(matrixView.y, (y + .5) * cellY / viewHeight);
      drawMatrix();
    }
    showCell();
  }
});
window.addEventListener("scroll", () => { matrixTooltip.hidden = true; }, {passive: true});
metricChart.addEventListener("pointermove", (event) => {
  const count = comparisonHistory?.entries.filter(({ values }) => values).length ?? 0;
  if (!count) return;
  const { left, width } = metricChart.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - left - 40) / Math.max(1, width - 58)));
  const index = Math.round(fraction * (count - 1));
  if (index === metricHover) return;
  metricHover = index;
  drawMetricHistory();
});
metricChart.addEventListener("pointerleave", () => {
  metricHover = null;
  drawMetricHistory();
});
metricChart.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const count = comparisonHistory?.entries.filter(({ values }) => values).length ?? 0;
  if (!count) return;
  event.preventDefault();
  const step = event.key === "ArrowLeft" ? -1 : 1;
  metricHover = Math.max(0, Math.min(count - 1, (metricHover ?? count - 1) + step));
  drawMetricHistory();
});
window.MusicWordParameters = {
  ready: Boolean(embedded),
  validate(values) {
    if (embedded) throw new Error("离线报告中的分析参数只读，请打开本地工作台。");
    if (!values || typeof values !== "object") throw new Error("SSM 参数方案无效。");
    for (const field of parameterFields) {
      const value = field.name === "parentEdgeTolerance" && !Object.hasOwn(values, field.name)
        ? field.defaultValue : values[field.name];
      const copy = field.cloneNode(true);
      copy.disabled = false;
      if (field.type === "checkbox") {
        if (typeof value !== "boolean") throw new Error("SSM 开关参数无效：" + field.name);
      } else {
        copy.value = value;
        if (value === undefined || !copy.checkValidity() ||
            (copy.tagName === "SELECT" && copy.value !== String(value))) {
          throw new Error("SSM 参数超出允许范围：" + field.name);
        }
      }
    }
    if (!strideStops.includes(Number(values.stride)) ||
        ["padTreeParents", "showRectangles", "showRawMatrix"].some((key) => typeof values[key] !== "boolean")) {
      throw new Error("SSM 步长或显示参数无效。");
    }
  },
  snapshot() {
    const values = {...parameterSnapshot(), showRectangles, showRawMatrix};
    this.validate(values);
    return values;
  },
  apply(values) {
    this.validate(values);
    setParameterValues({parentEdgeTolerance: form.elements.parentEdgeTolerance.defaultValue, ...values});
    setPadTreeParents(values.padTreeParents);
    if (showRectangles !== values.showRectangles) showRectanglesButton.click();
    if (showRawMatrix !== values.showRawMatrix) rawButton.click();
    markPresetEdited();
    queueRecalculation();
  },
};

window.addEventListener("resize", drawEverything);
window.visualViewport?.addEventListener("resize", drawEverything);
const observer = new ResizeObserver(drawEverything);
observer.observe(canvas.parentElement);
observer.observe(roll.parentElement);
observer.observe($("treeChart"));
if (embedded) {
  apply(JSON.parse(embedded.textContent));
  $("export").hidden = true;
  text("fileName", "离线报告");
  $("offlineNote").hidden = false;
  removeSelfSimilarityButton.disabled = true;
  for (const control of form.elements) {
    if (control !== padTreeParentsButton) control.disabled = true;
  }
} else {
  initializePresets().then(() => {
    window.MusicWordParameters.ready = true;
    if (!pending && !uploadedFile && !result) return run({example: true});
  });
  const classicalExamples = loadClassicalExamples().catch(() => null);
  initializeSharedAnnotations(classicalExamples);
}
