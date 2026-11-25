import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowCounterClockwise, CaretDown, ChartBar, Check, CheckCircle,
  DownloadSimple, Flask, GearSix, FloppyDisk, FolderOpen, Minus, Pause, PencilSimple, Play, Plus,
  Robot, SkipForward, SpeakerHigh, Stack, Trash, Waveform,
} from '@phosphor-icons/react';
import { FEATURE_KEYS, bpeStep, buildBpeHistory, buildHierarchyModel, makeEvents, normalizeTracks, wordColor } from './bpe';
import { PARAMETER_FILENAME, normalizeParameterFile } from './parameters';
import { AnnotationResults, AnnotationSimilarity } from './AnnotationAssist';
import { DEFAULT_MATCH_PARAMETERS, normalizeMatchParameters } from './annotation-match';
import {
  ANNOTATION_CATEGORIES, aggregateAnnotationNodes, annotationCategoryCounts, buildAnnotationExport,
  buildAnnotationHierarchy, buildAnnotationSelectionWord, buildAnnotationView,
  acceptAnnotationMatches, deleteAnnotationSegments, editAnnotation,
  layerCoverage, migrateLegacyAnnotation, nextEmptyAnnotationCategory, prepareAnnotationTrack, restoreAnnotationTracks,
} from './annotation';

const DEFAULT_WEIGHTS = { pitch: 1, velocity: .7, duration: .85, prevDelta: .65, nextDelta: .65, prevPitchDelta: .8, nextPitchDelta: .8 };
const FEATURE_LABELS = {
  pitch: '音高', velocity: '力度', duration: '时长',
  prevDelta: '距上个 onset', nextDelta: '距下个 onset',
  prevPitchDelta: '相对上个音高', nextPitchDelta: '相对下个音高',
};
const METRIC_LABELS = { cosine: '余弦', euclidean: '欧氏距离', manhattan: '曼哈顿距离' };
const ROLL_ZOOM_LEVELS = [12.5, 25, 50, 75, 100, 125, 150, 200, 300, 400];

function usePlayer(tpb) {
  const session = useRef(null);
  const [playing, setPlaying] = useState(null);

  const stop = useCallback(() => {
    session.current?.stop();
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback((word, instanceKey = word.id, animateProgress = true) => {
    if (!word?.notes?.length) return;
    stop();
    const notes = word.notes.map(({ onset, duration, pitch, velocity }) => [onset, onset + Math.max(1, duration), pitch, velocity]);
    const startTick = notes.reduce((start, note) => Math.min(start, note[0]), Infinity);
    const endTick = notes.reduce((end, note) => Math.max(end, note[1]), startTick);
    setPlaying({ key: instanceKey, startTick, endTick, progress: 0 });
    session.current = window.MusicWordPreview.play(notes, {
      tpb, from: startTick, to: endTick,
      onProgress: animateProgress ? (tick) => setPlaying({
        key: instanceKey, startTick, endTick, progress: (tick - startTick) / (endTick - startTick),
      }) : undefined,
      onEnd: () => { session.current = null; setPlaying(null); },
    });
  }, [stop, tpb]);

  return { play, stop, playing };
}

function playOnKey(event, play) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  play();
}

function Control({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  return <label className="control">
    <span>{label}<output>{value}{suffix}</output></span>
    <div className="control-row">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <input className="number" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  </label>;
}

function CodeNumber({ label, value, min, max, step = 1, onChange, integer = false }) {
  const [draft, setDraft] = useState(null);
  return <span className="bpe-code-number">
    <input
      className="bpe-code-value" type="number" aria-label={label} title={label}
      min={min} max={max} step={integer ? 1 : 'any'} inputMode={integer ? 'numeric' : 'decimal'}
      value={draft ?? value}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        const input = event.currentTarget;
        if (draft !== null && input.validity.valid && Number.isFinite(input.valueAsNumber)) {
          onChange(input.valueAsNumber);
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.currentTarget.reportValidity()) event.currentTarget.blur();
        }
        if (event.key === 'Escape') setDraft(null);
      }}
    />
    <input
      className="bpe-code-slider" type="range" aria-label={`${label}滑动条`}
      min={min} max={max} step={step} value={value}
      onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
    />
  </span>;
}

function BpePseudocode({ tpbParameter, saturationParameter, thresholdParameter, weightParameters, metric, setMetric }) {
  return <details className="bpe-pseudocode" open>
    <summary>BPE 算法伪代码</summary>
    <p className="bpe-code-hint">拖动滑动条即可调整参数。手动输入数字后，按回车或移开焦点应用。</p>
    <div className="bpe-code">
      <div className="bpe-code-block">
        <h3>量化音符并建立初始词典</h3>
        <pre><code>{`for 每条所选轨道 T:
  E[T] ← 按起音、音高排序(T)
  E[T] ← 量化(E[T],
    TPB = `}<CodeNumber {...tpbParameter} integer />{`)
  截断起音间隔(E[T],
    上限 = `}<CodeNumber {...saturationParameter} />{` 拍)

for 每个特征 k:
  用所有所选轨道的极值归一化特征 k

w ← {`}
          {FEATURE_KEYS.map((key) => <span key={key}>{`\n  ${FEATURE_LABELS[key]} = `}<CodeNumber {...weightParameters[key]} /></span>)}
          {`\n}
m ← `}<select className="bpe-code-value" aria-label="相似度方法" value={metric} onChange={(event) => setMetric(event.target.value)}>
            {Object.entries(METRIC_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>{`
事件相似度 ← 加权度量(m, w)
sim ← DTW(事件相似度)
τ ← `}<CodeNumber {...thresholdParameter} />{`

D ← 空词典
for 每条轨道 T:
  S[T] ← 空词序列
  for E[T] 中的每个事件 e:
    c ← 归类(e, D, 事件相似度, τ)
    S[T].追加(单音词(c, e))
    D[c].词频 ← D[c].词频 + 1`}</code></pre>
        <dl className="bpe-code-notes">
          <div><dt>归类</dt><dd>逐个比较已有类别的代表，选相似度最高且 ≥ 阈值 τ 的类别。同分时取先遇到的类别。如果没有匹配，则以当前项为代表新建一类。</dd></div>
          <div><dt>相似度</dt><dd>用加权特征比较单个事件。比较词对时，用动态时间规整（DTW）对齐音符序列，忽略首尾音符与词对外事件的间隔和音高差，并按序列长度比例施加惩罚。</dd></div>
        </dl>
      </div>
      <div className="bpe-code-block">
        <h3>逐轮合并相邻音乐词</h3>
        <pre><code>{`for r = 1 … 目标轮数:
  C ← 空候选簇集合
  for S 中的每条轨道词序列 W:
    for i = 0 … |W| − 2:
      P ← W[i] ⊕ W[i+1]
      归类(P, C, sim, τ)

  if C 为空: break
  R ← 成员最多的簇的代表
  # 并列时，优先代表含音符更多的簇

  for S 中的每条轨道词序列 W:
    W′ ← 空词序列
    i ← 0
    while i < |W|:
      if i + 1 < |W|:
        P ← W[i] ⊕ W[i+1]
        if sim(P, R) ≥ τ:
          W′.追加(新词(M[r], P))
          i ← i + 2
          continue
      W′.追加(W[i])
      i ← i + 1
    记录 W′ 为该轨道的新序列

  if 本轮未发生合并: break
  D[M[r]] ← 以 R 为代表的新词条
  S ← 各轨道的新词序列
  按 S 重新统计 D 中各词条的词频`}</code></pre>
        <p className="bpe-code-legend"><code>⊕</code> 拼接两词的实际音符，<code>|W|</code> 是轨道当前词数，<code>sim</code> 是序列相似度，<code>τ</code> 是匹配阈值。</p>
      </div>
    </div>
  </details>;
}

function TrackPicker({ tracks, selected, onChange }) {
  return <div className="track-list">
    {tracks.map((track) => {
      const checked = selected.includes(track.id);
      return <button className={`track-option ${checked ? 'selected' : ''}`} key={track.id} aria-pressed={checked} onClick={() => onChange(checked ? selected.filter((id) => id !== track.id) : [...selected, track.id])}>
        <span className="check-box">{checked && <Check size={12} weight="bold" />}</span>
        <span><strong>{track.name}</strong><small>{track.instrument} · {track.notes.length} notes</small></span>
      </button>;
    })}
  </div>;
}

function WordPianoRoll({ word, active = false, progress = 0, highlightedNoteId = null, className = '' }) {
  const notes = [...word.notes].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  const start = Math.min(...notes.map((note) => note.onset));
  const end = Math.max(...notes.map((note) => note.onset + note.duration));
  const low = Math.min(...notes.map((note) => note.pitch));
  const high = Math.max(...notes.map((note) => note.pitch));
  const tickSpan = Math.max(1, end - start);
  const pitchSpan = Math.max(1, high - low + 1);
  const x = (tick) => 2 + ((tick - start) / tickSpan) * 116;
  const y = (pitch) => 3 + ((high - pitch) / pitchSpan) * 27;
  return <svg className={`word-roll ${className}`} viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">
    <rect className="word-roll-bg" width="120" height="34" rx="3" />
    <line className="word-roll-mid" x1="0" x2="120" y1="17" y2="17" />
    {notes.map((note, index) => {
      const highlighted = highlightedNoteId != null && note.id === highlightedNoteId;
      return <rect key={`${note.id ?? note.pitch}:${index}`} className={`word-roll-note ${highlighted ? 'highlighted' : ''}`} x={x(note.onset)} y={y(note.pitch)} width={Math.max(3, note.duration / tickSpan * 116)} height={Math.max(3, 25 / pitchSpan)} rx="1" />;
    })}
    {active && <line className="word-roll-playhead" x1={2 + progress * 116} x2={2 + progress * 116} y1="1" y2="33" />}
  </svg>;
}

const wordLevel = (word) => Number.isFinite(word?.level) ? word.level : word.id.startsWith('M') ? Number(word.id.slice(1)) : 0;
const levelLetter = (level) => String.fromCharCode(65 + Math.min(25, Math.max(0, level)));

function LevelBadge({ level }) {
  return <span className="level-badge" title={`层级 ${level}`}>{levelLetter(level)}</span>;
}

function LevelSelector({ levels, selected, onToggle, disabled = false }) {
  return <fieldset className="level-selector" disabled={disabled}>
    <legend>显示层级</legend>
    {levels.map((level) => <label key={level} className={selected.includes(level) ? 'checked' : ''}>
      <input type="checkbox" checked={selected.includes(level)} onChange={() => onToggle(level)} />
      <span>{levelLetter(level)}</span><small>L{level}</small>
    </label>)}
  </fieldset>;
}

function TopLayerToggle({ checked, onChange }) {
  return <label className="top-layer-toggle">
    <input type="checkbox" role="switch" aria-label="仅显示顶层词" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span aria-hidden="true"><i /></span>
    <small>仅顶层词</small>
  </label>;
}

function SelectionPlaybackToggle({ checked, onChange }) {
  return <label className="top-layer-toggle annotation-playback-toggle">
    <input type="checkbox" role="switch" aria-label="框选后播放片段" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span aria-hidden="true"><i /></span>
    <small><SpeakerHigh size={13} />框选后播放片段</small>
  </label>;
}

function HierarchyTree({ track, history = [], words, width, endTick, onPlay, playing, selectedWordId, focusedInstanceKey, providedModel = null, selectedNodes, onSelectNodes, onAggregate, canAggregate, onDelete }) {
  const selectable = Boolean(onSelectNodes);
  const gesture = useRef(null);
  const [marquee, setMarquee] = useState(null);
  const model = useMemo(() => providedModel ?? buildHierarchyModel(history, track.id), [providedModel, history, track.id]);
  const layerLabel = (level) => providedModel ? `L${level}` : `${levelLetter(level)} · L${level}`;
  const currentBySource = useMemo(() => new Map(words.map((word, index) => [`${word.sourceIndex}:${word.id}`, index])), [words]);
  const nodeHeight = 32;
  const { layout, rows, treeHeight } = useMemo(() => {
    const scaleX = (tick) => (tick / endTick) * width;
    const byLevel = Array.from({ length: model.maxLevel + 1 }, () => []);
    for (const node of model.nodes) {
      const start = Math.min(...node.word.notes.map((note) => note.onset));
      const end = Math.max(...node.word.notes.map((note) => note.onset + note.duration));
      const nodeWidth = Math.min(180, Math.max(16, scaleX(end) - scaleX(start) + 4));
      const center = (scaleX(start) + scaleX(end)) / 2;
      const x = Math.max(2, Math.min(width - nodeWidth - 2, center - nodeWidth / 2));
      byLevel[node.level].push({ ...node, x, width: nodeWidth, start, end });
    }
    const layout = new Map();
    const rows = [];
    let y = 10;
    for (let level = model.maxLevel; level >= 0; level--) {
      const nodes = byLevel[level];
      const laneEnds = [];
      if (selectable) nodes.sort((a, b) => a.x - b.x);
      for (const node of nodes) {
        const openLane = laneEnds.findIndex((end) => end <= node.x);
        const lane = selectable ? (openLane < 0 ? laneEnds.length : openLane) : 0;
        laneEnds[lane] = node.x + node.width + 2;
        layout.set(node.key, { ...node, y: y + lane * 38, height: nodeHeight });
      }
      const height = 48 + Math.max(0, laneEnds.length - 1) * 38;
      rows.push({ level, y });
      y += height;
    }
    return { layout, rows, treeHeight: y + 10 };
  }, [model, width, endTick, selectable]);
  const point = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * width / bounds.width, y: (event.clientY - bounds.top) * treeHeight / bounds.height };
  };
  const selectionBox = (start, end) => ({
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y),
  });
  const selectNode = (node) => onSelectNodes(track.id, node.level, [node.word.instanceId], true);

  return <>
    <div className={`tree-heading ${selectable ? 'annotation-tree-heading' : ''}`}>
      <span><Stack size={13} /> 层级树</span>
      {selectable ? <div className="annotation-tree-actions">
        <small>点选或框选同层节点</small>
        <button type="button" className="primary-button" onClick={onAggregate} disabled={!canAggregate}><Check size={15} weight="bold" />聚合</button>
        <button type="button" className="secondary-button" onClick={onDelete} disabled={!onDelete}><Trash size={15} />删除所选标注</button>
      </div> : <small>{model.nodes.length} NODES · 点击节点试听</small>}
    </div>
    <svg className={`word-tree ${selectable ? 'selectable' : ''}`} width={width} height={treeHeight} role="group" aria-label={`${track.name} 音乐词层级树`}
      onPointerDown={selectable ? (event) => {
        if (event.button !== 0 || gesture.current) return;
        const start = point(event);
        const key = event.target.closest('[data-node-key]')?.getAttribute('data-node-key');
        gesture.current = { start, key, pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      } : undefined}
      onPointerMove={selectable ? (event) => {
        if (gesture.current?.pointerId === event.pointerId) setMarquee(selectionBox(gesture.current.start, point(event)));
      } : undefined}
      onPointerUp={selectable ? (event) => {
        const drag = gesture.current;
        if (drag?.pointerId !== event.pointerId) return;
        gesture.current = null;
        setMarquee(null);
        const box = selectionBox(drag.start, point(event));
        if (box.width < 4 && box.height < 4) {
          const node = layout.get(drag.key);
          if (node) selectNode(node);
          return;
        }
        const hits = [...layout.values()].filter((node) => node.x < box.x + box.width && node.x + node.width > box.x
          && node.y < box.y + box.height && node.y + node.height > box.y);
        if (!hits.length) return;
        const middle = box.y + box.height / 2;
        const distance = (node) => Math.abs(node.y + node.height / 2 - middle);
        const anchor = hits.find((node) => node.key === drag.key)
          ?? hits.reduce((closest, node) => distance(node) < distance(closest) ? node : closest);
        const ids = hits.filter((node) => node.level === anchor.level).map((node) => node.word.instanceId);
        onSelectNodes(track.id, anchor.level, ids, false);
      } : undefined}
      onPointerCancel={selectable ? () => { gesture.current = null; setMarquee(null); } : undefined}>
      <rect width={width} height={treeHeight} className="tree-background" />
      {rows.map(({ level, y: rowY }) => <g key={level} aria-hidden="true">
          <line x1="0" x2={width} y1={rowY + nodeHeight / 2} y2={rowY + nodeHeight / 2} className="tree-row-line" />
          <text x="7" y={rowY + 9} className="tree-level-label">{layerLabel(level)}</text>
        </g>)}
      <g className="tree-links" aria-hidden="true">
        {model.edges.map((edge, index) => {
          const parent = layout.get(edge.parentKey);
          const child = layout.get(edge.childKey);
          if (!parent || !child) return null;
          const parentX = parent.x + parent.width / 2;
          const childX = child.x + child.width / 2;
          const startY = parent.y + parent.height;
          const endY = child.y;
          const middleY = (startY + endY) / 2;
          return <path key={`${edge.parentKey}:${edge.childKey}:${index}`} d={`M ${parentX} ${startY} C ${parentX} ${middleY}, ${childX} ${middleY}, ${childX} ${endY}`} />;
        })}
      </g>
      {model.nodes.map((node) => {
        const item = layout.get(node.key);
        const { word, level, x: nodeX, y: nodeY, width: nodeWidth } = item;
        const color = wordColor(word);
        const key = `tree:${track.id}:${node.key}`;
        const currentIndex = currentBySource.get(`${word.sourceIndex}:${word.id}`);
        const target = currentIndex == null ? null : { trackId: track.id, index: currentIndex };
        const active = playing?.key === key;
        const selected = selectable ? selectedNodes?.has(word.instanceId) : selectedWordId === word.id;
        const focused = focusedInstanceKey === key;
        const low = Math.min(...word.notes.map((note) => note.pitch));
        const high = Math.max(...word.notes.map((note) => note.pitch));
        const pitchSpan = Math.max(1, high - low + 1);
        const tickSpan = Math.max(1, item.end - item.start);
        const clipId = `tree-clip-${track.id}-${node.key}`.replace(/[^a-zA-Z0-9_-]/g, '-');
        const playNode = () => onPlay(word, key, target);
        return <g key={node.key} data-node-key={selectable ? node.key : undefined} data-level={selectable ? level : undefined}
          className={`tree-node ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`} style={{ color }} role="button" tabIndex="0"
          aria-label={selectable ? `选择 L${level} ${word.label}，${word.notes.length} 个音符` : `播放层级 ${level} 音乐词 ${word.id}`}
          aria-pressed={selectable ? Boolean(selected) : undefined}
          onClick={selectable ? (event) => { if (event.detail === 0) selectNode(node); } : playNode}
          onKeyDown={(event) => {
            if (selectable || (event.key !== ' ' && event.key !== 'Enter')) return;
            event.preventDefault();
            playNode();
          }}>
          <title>{layerLabel(level)} · {word.label ?? word.id} · {word.notes.length} 音符</title>
          <defs><clipPath id={clipId}><rect x={nodeX + 2} y={nodeY + 2} width={Math.max(1, nodeWidth - 4)} height={nodeHeight - 4} rx="3" /></clipPath></defs>
          <rect className="tree-node-shell" x={nodeX} y={nodeY} width={nodeWidth} height={nodeHeight} rx="4" />
          <g clipPath={`url(#${clipId})`}>
            {word.notes.map((note, index) => {
              const noteX = nodeX + 3 + ((note.onset - item.start) / tickSpan) * (nodeWidth - 6);
              const noteY = nodeY + 4 + ((high - note.pitch) / pitchSpan) * (nodeHeight - 10);
              return <rect key={`${note.id ?? note.pitch}:${index}`} className="tree-node-note" x={noteX} y={noteY} width={Math.max(2.5, (note.duration / tickSpan) * (nodeWidth - 6))} height={Math.max(2.5, (nodeHeight - 10) / pitchSpan)} rx="1" />;
            })}
          </g>
          {nodeWidth >= 34 && <text className="tree-node-label" x={nodeX + 5} y={nodeY + nodeHeight - 5}>{providedModel ? word.label : `${levelLetter(level)} · ${word.id}`}</text>}
        </g>;
      })}
      {marquee && <rect className="selection-marquee" {...marquee} />}
    </svg>
  </>;
}

function PianoRoll({ track, sequence, history, tpb, onPlay, playing, selectedWordId, focusedInstanceKey, jumpTarget, levels, visibleLevels, onToggleLevel, topWordsOnly, onTopWordsOnlyChange, referenceSegments = [] }) {
  const panelRef = useRef(null);
  const scrollRef = useRef(null);
  const zoomAnchor = useRef(null);
  const lastJump = useRef(null);
  const [zoom, setZoom] = useState(100);
  const zoomIndex = ROLL_ZOOM_LEVELS.indexOf(zoom);
  const words = sequence?.words ?? [];
  const notes = track.events;
  const minPitch = Math.max(0, Math.min(...notes.map((n) => n.pitch)) - 2);
  const maxPitch = Math.min(127, Math.max(...notes.map((n) => n.pitch)) + 2);
  const endTick = track.evaluationEnd ?? Math.max(...notes.map((n) => n.onset + n.duration), tpb * 4);
  const width = Math.round(Math.max(1080, Math.ceil(endTick / tpb) * 58) * zoom / 100);
  const height = Math.max(230, (maxPitch - minPitch + 1) * 9);
  const x = (tick) => (tick / endTick) * width;
  const y = (pitch) => (maxPitch - pitch) * 9 + 4;
  const changeZoom = (nextZoom) => {
    if (nextZoom === zoom) return;
    const scroller = scrollRef.current;
    if (scroller.scrollLeft > 0) {
      const offset = scroller.clientWidth / 2;
      zoomAnchor.current = { position: (scroller.scrollLeft + offset) / width, offset };
    }
    setZoom(nextZoom);
  };
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    if (!anchor) return;
    scrollRef.current.scrollLeft = anchor.position * width - anchor.offset;
    zoomAnchor.current = null;
  }, [width]);
  const wordInstances = useMemo(() => {
    if (topWordsOnly) return words.map((word, index) => ({ word, level: wordLevel(word), currentIndex: index, key: `${track.id}:${index}` }));

    const currentBySource = new Map(words.map((word, index) => [`${word.sourceIndex}:${word.id}`, index]));
    return history.flatMap((layer) => {
      const layerSequence = layer.sequences.find((item) => item.trackId === track.id);
      if (!layerSequence) return [];
      return layerSequence.words
        .filter((word) => layer.round === 0 ? wordLevel(word) === 0 : wordLevel(word) === layer.round)
        .filter((word) => visibleLevels.includes(wordLevel(word)))
        .map((word, index) => {
          const level = wordLevel(word);
          const currentIndex = currentBySource.get(`${word.sourceIndex}:${word.id}`);
          return {
            word,
            level,
            currentIndex,
            key: currentIndex == null ? `${track.id}:layer:${level}:${word.sourceIndex ?? index}` : `${track.id}:${currentIndex}`,
          };
        });
    }).sort((a, b) => b.level - a.level || (a.word.sourceIndex ?? 0) - (b.word.sourceIndex ?? 0));
  }, [history, topWordsOnly, track.id, visibleLevels, words]);
  useEffect(() => {
    if (!jumpTarget || jumpTarget.trackId !== track.id || jumpTarget === lastJump.current) return;
    const targetWord = words[jumpTarget.index];
    if (!targetWord) return;
    lastJump.current = jumpTarget;
    const start = Math.min(...targetWord.notes.map((note) => note.onset));
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    scrollRef.current?.scrollTo({ left: Math.max(0, x(start) - scrollRef.current.clientWidth / 2), behavior: 'smooth' });
  }, [jumpTarget, track.id, words, width, endTick]);
  return <section className="panel piano-panel" ref={panelRef} data-top-words-only={topWordsOnly || undefined}>
    <div className="panel-heading">
      <div><span className="kicker">PIANO ROLL</span><h2>{track.name}</h2></div>
      <div className="roll-heading-tools">
        <div className="roll-zoom" role="group" aria-label="时间轴缩放">
          <span aria-hidden="true">时间轴</span>
          <button type="button" aria-label="缩小时间轴" title="缩小时间轴" disabled={zoomIndex === 0} onClick={() => changeZoom(ROLL_ZOOM_LEVELS[zoomIndex - 1])}><Minus size={15} /></button>
          <button type="button" className="roll-zoom-value" aria-label={`当前缩放 ${zoom}%，恢复默认缩放`} title="恢复到 100%" onClick={() => changeZoom(100)}>{zoom}%</button>
          <button type="button" aria-label="放大时间轴" title="放大时间轴" disabled={zoomIndex === ROLL_ZOOM_LEVELS.length - 1} onClick={() => changeZoom(ROLL_ZOOM_LEVELS[zoomIndex + 1])}><Plus size={15} /></button>
        </div>
        <TopLayerToggle checked={topWordsOnly} onChange={onTopWordsOnlyChange} />
        <LevelSelector levels={levels} selected={visibleLevels} onToggle={onToggleLevel} disabled={topWordsOnly} />
        <button type="button" className="secondary-button" onClick={() => onPlay({ id: track.id, notes }, `track:${track.id}`)}>播放音轨</button>
        <span className="meta">{notes.length} EVENTS · {Math.ceil(endTick / tpb)} BEATS · 点击词框试听</span>
      </div>
    </div>
    <div className="roll-scroll" ref={scrollRef}>
      <HierarchyTree track={track} history={history} words={words} width={width} endTick={endTick} onPlay={onPlay} playing={playing} selectedWordId={selectedWordId} focusedInstanceKey={focusedInstanceKey} />
      <svg className="piano-roll" width={width} height={height} role="group" aria-label={`${track.name} piano roll`}>
        <rect width={width} height={height} fill="var(--roll-bg)" />
        {Array.from({ length: Math.ceil(endTick / tpb) + 1 }, (_, i) => <line key={i} x1={x(i * tpb)} x2={x(i * tpb)} y1="0" y2={height} className={i % 4 === 0 ? 'bar-line' : 'beat-line'} />)}
        {notes.map((note) => <rect key={note.id} x={x(note.onset)} y={y(note.pitch)} width={Math.max(2, x(note.duration))} height="7" rx="1.5" fill="#76766d" opacity={topWordsOnly ? .45 : .74} />)}
        {wordInstances.map(({ word, level, currentIndex, key }) => {
          const start = Math.min(...word.notes.map((n) => n.onset));
          const end = Math.max(...word.notes.map((n) => n.onset + n.duration));
          const low = Math.min(...word.notes.map((n) => n.pitch));
          const high = Math.max(...word.notes.map((n) => n.pitch));
          const active = playing?.key === key;
          const selected = selectedWordId === word.id;
          const focused = focusedInstanceKey === key;
          const color = wordColor(word);
          const restingOpacity = topWordsOnly ? .28 : level ? .075 : .1;
          const fillOpacity = active ? (topWordsOnly ? .55 : .34) : selected ? (topWordsOnly ? .42 : .24) : restingOpacity;
          const strokeWidth = focused ? 3.5 : active || selected ? 2.5 : topWordsOnly ? 2 : level ? 1.5 : 1.3;
          const layerPad = Math.min(9, level * 1.75);
          const boxX = Math.max(1, x(start) - 2 - layerPad);
          const boxY = Math.max(1, y(high) - 3 - layerPad);
          const boxRight = Math.min(width - 1, x(end) + 2 + layerPad);
          const boxBottom = Math.min(height - 1, y(low) + 11 + layerPad);
          const target = currentIndex == null ? null : { trackId: track.id, index: currentIndex };
          const playInstance = () => onPlay(word, key, target);
          return <g className={`word-box ${level ? 'higher-level' : 'base-level'} ${selected ? 'selected' : ''} ${focused ? 'focused' : ''} ${active ? 'active' : ''}`} style={{ color }} key={key} role="button" tabIndex="0" aria-label={`播放层级 ${level} 音乐词 ${word.id}`} onClick={playInstance} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); playInstance(); } }}>
            <rect x={boxX} y={boxY} width={Math.max(7, boxRight - boxX)} height={Math.max(15, boxBottom - boxY)} rx={3 + Math.min(2, level * .4)} fill={color} fillOpacity={fillOpacity} stroke={color} strokeWidth={strokeWidth} />
            <circle className="roll-level-dot" cx={boxX + 1} cy={boxY + 1} r="6" fill={color} />
            <text className="roll-level-letter" x={boxX + 1} y={boxY + 1}>{levelLetter(level)}</text>
            {active && <line x1={x(start + (end - start) * playing.progress)} x2={x(start + (end - start) * playing.progress)} y1={y(high) - 5} y2={y(low) + 13} stroke="#fff6dc" strokeWidth="2" />}
          </g>;
        })}
        <g aria-label="人工标注">
          {referenceSegments.map(({ id, notes, categoryId, color }) => {
            const start = Math.min(...notes.map((note) => note.start));
            const end = Math.max(...notes.map((note) => note.end));
            const top = y(Math.max(...notes.map((note) => note.pitch))) - 3;
            const bottom = y(Math.min(...notes.map((note) => note.pitch))) + 10;
            const playSegment = () => onPlay({ id, notes: notes.map((note) => ({
              onset: note.start, duration: note.end - note.start, pitch: note.pitch, velocity: note.velocity,
            })) }, `reference:${id}`);
            return <g key={id} className="mw-playable" role="button" tabIndex="0" aria-label={`试听人工标注 ${categoryId}`}
              onClick={playSegment} onKeyDown={(event) => playOnKey(event, playSegment)}>
              <rect x={x(start)} y={top} width={Math.max(3, x(end) - x(start))} height={bottom - top}
                fill="none" stroke={color} strokeWidth="2" strokeDasharray="5 3" pointerEvents="stroke" />
              <text x={x(start) + 3} y={top - 2} fill={color} fontSize="11">{categoryId}</text>
            </g>;
          })}
        </g>
      </svg>
    </div>
  </section>;
}

function AnnotationPianoRoll({ track, annotation, level, categories, selection, location, match, onSelectNodes, onSelectNotes, onAggregate, canAggregate, onDelete, onMessage, onPlay, playing, selectedWordId, tpb }) {
  const panelRef = useRef(null);
  const svgRef = useRef(null);
  const scrollRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const notes = track.events;
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const minPitch = Math.max(0, Math.min(...notes.map((note) => note.pitch)) - 2);
  const maxPitch = Math.min(127, Math.max(...notes.map((note) => note.pitch)) + 2);
  const endTick = Math.max(...notes.map((note) => note.onset + note.duration), 96);
  const width = Math.max(1080, Math.ceil(endTick / tpb) * 58);
  const height = Math.max(230, (maxPitch - minPitch + 1) * 9);
  const x = (tick) => (tick / endTick) * width;
  const y = (pitch) => (maxPitch - pitch) * 9 + 4;
  const firstOnset = Math.min(...notes.map((note) => note.onset));
  useEffect(() => {
    const scroller = scrollRef.current;
    const firstX = firstOnset / endTick * width;
    if (scroller && firstX > scroller.clientWidth * .8) scroller.scrollLeft = Math.max(0, firstX - 48);
  }, [track.id, firstOnset, endTick, width]);
  const layer = annotation.layers[level];
  const currentWords = useMemo(() => buildAnnotationView([annotation], [track], level, categories).sequences[0]?.words ?? [], [annotation, track, level, categories]);
  const hierarchyModel = useMemo(() => buildAnnotationHierarchy(annotation, track, categories), [annotation, track, categories]);
  const canSelectNotes = level <= 1 && layer.role !== 'top';
  const sourceSegments = annotation.layers[0].segments;
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const geometryFor = useCallback((segment) => {
    const segmentNotes = segment.noteIds.map((id) => noteById.get(id)).filter(Boolean);
    if (!segmentNotes.length) return null;
    const start = Math.min(...segmentNotes.map((note) => note.onset));
    const end = Math.max(...segmentNotes.map((note) => note.onset + note.duration));
    const low = Math.min(...segmentNotes.map((note) => note.pitch));
    const high = Math.max(...segmentNotes.map((note) => note.pitch));
    return {
      x: Math.max(1, x(start) - 3), y: Math.max(1, y(high) - 4),
      width: Math.max(8, x(end) - x(start) + 6), height: Math.max(16, y(low) - y(high) + 15),
    };
  }, [noteById, width, height, endTick, minPitch, maxPitch]);
  const sourceVisuals = useMemo(() => sourceSegments.map((segment) => ({ segment, box: geometryFor(segment) })).filter((item) => item.box), [sourceSegments, geometryFor]);
  const currentVisuals = useMemo(() => layer.segments.map((segment) => ({ segment, box: geometryFor(segment) })).filter((item) => item.box), [layer.segments, geometryFor]);
  const located = location?.level === level ? currentVisuals.find(({ segment }) => segment.id === location.segmentId) : null;
  const focusedTreeKey = located ? `tree:${track.id}:${level}:${located.segment.id}` : null;
  const matchBox = useMemo(() => {
    const box = match && geometryFor(match);
    return box && { ...box, width: Math.min(box.width, width - box.x - 1) };
  }, [match, geometryFor, width]);
  const matchedNoteIds = useMemo(() => new Set(match?.noteIds), [match]);
  useLayoutEffect(() => {
    const box = matchBox ?? located?.box;
    if (!box) return;
    const scroller = scrollRef.current;
    const { x, width } = box;
    if (matchBox) {
      scroller.scrollLeft = x + width / 2 - scroller.clientWidth / 2;
      const highlight = svgRef.current.querySelector('.annotation-match');
      highlight.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      highlight.focus({ preventScroll: true });
      return;
    }
    panelRef.current.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
    scroller.scrollLeft = x + width / 2 - scroller.clientWidth / 2;
    scroller.querySelector('.word-tree .tree-node.focused')?.focus({ preventScroll: true });
  }, [located, location, matchBox]);
  const selectedIds = selection?.trackId === track.id ? new Set(selection.noteIds) : new Set();
  const selectedSourceIds = selection?.trackId === track.id ? new Set(selection.sourceSegmentIds) : new Set();
  const pointFromEvent = (event) => {
    const bounds = svgRef.current.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * width / bounds.width, y: (event.clientY - bounds.top) * height / bounds.height };
  };
  const playSegment = (segment) => onPlay({
    id: segment.id, notes: segment.noteIds.map((id) => noteById.get(id)).filter(Boolean),
  }, `annotation-roll:${segment.id}`);
  const contains = (box, point) => point.x >= box.x && point.x <= box.x + box.width
    && point.y >= box.y && point.y <= box.y + box.height;
  const finishSelection = (event) => {
    if (!drag) return;
    const point = pointFromEvent(event);
    const selectionBox = {
      x: Math.min(drag.x, point.x), y: Math.min(drag.y, point.y),
      width: Math.abs(point.x - drag.x), height: Math.abs(point.y - drag.y),
    };
    const click = selectionBox.width < 4 && selectionBox.height < 4;
    const clickedWord = click && currentVisuals.findLast(({ segment, box }) => !segment.automatic && contains(box, point));
    let hits = sourceVisuals.filter(({ box }) => click
      ? contains(box, point)
      : box.x < selectionBox.x + selectionBox.width && box.x + box.width > selectionBox.x && box.y < selectionBox.y + selectionBox.height && box.y + box.height > selectionBox.y);
    if (click) hits = hits.slice(-1);
    if (!hits.length) onMessage('请框选音符');
    else onSelectNotes(track.id, hits.map((item) => item.segment.id), click, !clickedWord);
    if (clickedWord) playSegment(clickedWord.segment);
    setDrag(null);
    try { svgRef.current.releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be released */ }
  };

  return <section className="panel annotation-roll-panel" ref={panelRef}>
    <div className="panel-heading annotation-roll-heading">
      <div><h2>{track.name}</h2><span className="meta">{notes.length} 音符 · {layer.name} · {layerCoverage(annotation, level).percent}% 已覆盖</span></div>
      <div className="annotation-roll-tools">
        <span className="annotation-legend">
          <i className="legend-current" />当前层标注
        </span>
        <button type="button" className="secondary-button" onClick={() => onPlay({ id: track.id, notes }, `track:${track.id}`)}>播放音轨</button>
      </div>
    </div>
    <div className="roll-scroll" ref={scrollRef}>
      <HierarchyTree track={track} words={currentWords} width={width} endTick={endTick} onPlay={onPlay} playing={playing} selectedWordId={selectedWordId}
        providedModel={hierarchyModel} selectedNodes={selectedSourceIds} focusedInstanceKey={focusedTreeKey} onSelectNodes={onSelectNodes}
        onAggregate={onAggregate} canAggregate={canAggregate && selection?.kind === 'tree' && selection.trackId === track.id} onDelete={onDelete} />
      <svg
        ref={svgRef}
        className={`piano-roll annotation-roll ${canSelectNotes ? '' : 'read-only'}`}
        style={match?.color ? { '--match-color': match.color } : undefined}
        width={width}
        height={height}
        role="application"
        aria-label={`${track.name} 标注钢琴卷帘`}
        onPointerDown={(event) => {
          if (!canSelectNotes || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointFromEvent(event);
          setDrag(point);
        }}
        onPointerMove={(event) => drag && setDrag((start) => ({ ...start, current: pointFromEvent(event) }))}
        onPointerUp={finishSelection}
        onPointerCancel={() => setDrag(null)}
      >
        <rect width={width} height={height} fill="var(--roll-bg)" />
        {Array.from({ length: Math.ceil(endTick / tpb) + 1 }, (_, index) => <line key={index} x1={x(index * tpb)} x2={x(index * tpb)} y1="0" y2={height} className={index % 4 === 0 ? 'bar-line' : 'beat-line'} />)}
        {notes.map((note) => <rect key={note.id} className={`annotation-note${selectedIds.has(note.id) ? ' selected' : ''}${matchedNoteIds.has(note.id) ? ' matched' : ''}`} x={x(note.onset)} y={y(note.pitch)} width={Math.max(2, x(note.duration))} height="7" rx="1.5" />)}
        {canSelectNotes && sourceVisuals.map(({ segment, box }) => <rect key={segment.id} className={selectedSourceIds.has(segment.id) ? 'source-word selected' : 'source-word'} {...box} rx="3" />)}
        {currentVisuals.map(({ segment, box }) => {
          const category = categoryById.get(segment.categoryId);
          const color = category?.color ?? (segment.categoryId === 'SONG' ? '#77766d' : '#5e5d55');
          const selected = selectedSourceIds.has(segment.id);
          return <g key={segment.id} data-segment-id={segment.id} className={`manual-word mw-playable ${segment.automatic ? 'automatic' : ''} ${selected ? 'selected' : ''} ${segment === located?.segment ? 'focused' : ''}`} style={{ color, pointerEvents: canSelectNotes ? undefined : 'all' }}
            role="button" tabIndex="0" aria-label={`试听${category?.label ?? '片段'}`}
            onClick={canSelectNotes ? undefined : () => playSegment(segment)}
            onKeyDown={(event) => playOnKey(event, () => playSegment(segment))}>
            <rect {...box} rx="4" />
            {box.width >= 42 && <text x={box.x + 5} y={box.y + 11}>{category?.label ?? (segment.categoryId === 'SONG' ? '整首' : '音符')}</text>}
          </g>;
        })}
        {matchBox && <rect className="annotation-match" {...matchBox} rx="4" tabIndex={-1} role="img" aria-label={`匹配片段，${matchedNoteIds.size} 个音符`} />}
        {drag?.current && <rect className="selection-marquee" x={Math.min(drag.x, drag.current.x)} y={Math.min(drag.y, drag.current.y)} width={Math.abs(drag.current.x - drag.x)} height={Math.abs(drag.current.y - drag.y)} />}
      </svg>
    </div>
  </section>;
}

function AnnotationDictionary({ level, categories, entries, sequences, trackNames, selectedCategory, onSelectCategory, selection, onConfirm, canConfirm, onUndo, canUndo, message, onPlay, playing, onSearch, editing, onCancelEdit }) {
  const [expandedCategoryId, setExpandedCategoryId] = useState(null);
  const fromRoll = selection?.kind === 'roll';
  const selectionLabel = selection
    ? `已选择 ${fromRoll ? `${selection.noteIds.length} 个音符` : `${selection.sourceSegmentIds.length} 个 L${selection.level} 节点`}${selectedCategory ? ` · 新节点词类 ${selectedCategory}` : ''}`
    : '等待选择';
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const examplesByCategory = useMemo(() => {
    const examples = new Map();
    sequences.forEach((sequence) => sequence.words.forEach((word) => {
      if (!examples.has(word.id)) examples.set(word.id, []);
      examples.get(word.id).push({ word, trackId: sequence.trackId });
    }));
    return examples;
  }, [sequences]);
  return <section className="panel dictionary-panel annotation-dictionary">
    <div className="panel-heading">
      <h2>L{level} 类别字典</h2>
      <div className="selection-status" aria-live="polite">
        <span className={selection ? 'ready' : ''}>{selectionLabel}</span>
        <small>{message}</small>
      </div>
    </div>
    <div className="dictionary-grid annotation-dictionary-grid">
      {categories.map((category, index) => {
        const entry = entryById.get(category.id);
        const selected = selectedCategory === category.id;
        const examples = examplesByCategory.get(category.id) ?? [];
        const expandable = examples.length > 0;
        const expanded = expandable && expandedCategoryId === category.id;
        const examplesId = `annotation-examples-${category.id}`;
        return <article key={category.id} className={`word-card category-slot ${selected ? 'selected' : ''} ${entry ? '' : 'empty'} ${expanded ? 'expanded' : ''}`} style={{ '--word-color': category.color }}>
          <button className="word-card-main category-slot-main" onClick={() => onSelectCategory(category.id)} aria-pressed={selected}
            aria-label={`选择${category.label}${index < 9 ? `，快捷键 ${index + 1}` : ''}`}>
            <span className="word-top"><span>{index < 9 && <kbd>{index + 1}</kbd>}<b>{category.id}</b></span>{selected && <CheckCircle size={17} weight="fill" />}</span>
            {entry ? <WordPianoRoll word={entry} active={playing?.key === `dict:${entry.id}`} progress={playing?.progress} /> : <span className="empty-category-slot">空类别</span>}
            <span className="word-bottom"><span>{category.label}</span><span>{entry?.count ?? 0}×</span></span>
          </button>
          {entry && <div className="category-card-actions">
            <button onClick={() => onPlay(entry, `dict:${entry.id}`)} aria-label={`播放词类 ${entry.id} 的代表样例`}><Play size={12} weight="fill" />试听</button>
            {!entry.automatic && <button onClick={() => onSearch(entry, examples[0].trackId)} aria-label={`查找词类 ${entry.id} 的相似片段`}>查找相似片段</button>}
            {expandable && <button
              aria-expanded={expanded}
              aria-controls={examplesId}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => setExpandedCategoryId(expanded ? null : category.id)}
            ><CaretDown className={expanded ? 'expanded' : ''} size={12} weight="bold" />{examples.length} 子例</button>}
          </div>}
          {expanded && <div className="word-examples annotation-examples" id={examplesId}>
            {examples.map((example, exampleIndex) => {
              const key = `annotation-example:${example.trackId}:${example.word.instanceId}`;
              return <button key={key} className={playing?.key === key ? 'active' : ''} onKeyDown={(event) => event.stopPropagation()} onClick={() => onPlay(example.word, key)}>
                <span>{trackNames[example.trackId] ?? example.trackId} · 子例 #{exampleIndex + 1} · {example.word.notes.length} 音符</span>
                <WordPianoRoll word={example.word} active={playing?.key === key} progress={playing?.progress} />
              </button>;
            })}
          </div>}
        </article>;
      })}
    </div>
    <div className="annotation-confirm-bar">
      <p>{editing ? `正在编辑词类 ${editing.categoryId} 的范围：${editing.level === 1 ? '重新框选音符' : `选择 L${editing.level - 1} 节点`}后确认；保留原标注编号。` : selection ? (canConfirm ? `将在 L${selection.level + 1} 生成新节点。` : '') : '在层级树点选或框选节点。'}</p>
      <div>
        <button className="secondary-button" onClick={onUndo} disabled={!canUndo}><ArrowCounterClockwise size={15} />撤销</button>
        {editing && <button className="secondary-button" onClick={onCancelEdit}>取消编辑</button>}
        {(fromRoll || editing) && <button className="primary-button" onClick={onConfirm} disabled={!canConfirm}><Check size={16} weight="bold" />{editing ? '保存修改' : '确定'}</button>}
      </div>
    </div>
  </section>;
}

function Dictionary({ entries, sequences, trackNames, onPlay, playing, selectedWordId }) {
  const [expandedWordId, setExpandedWordId] = useState(null);
  const sorted = [...entries].sort((a, b) => b.level - a.level || b.count - a.count);
  const examplesByWord = useMemo(() => {
    const examples = new Map();
    sequences.forEach((sequence) => sequence.words.forEach((word, index) => {
      if (!examples.has(word.id)) examples.set(word.id, []);
      examples.get(word.id).push({ word, trackId: sequence.trackId, index });
    }));
    return examples;
  }, [sequences]);
  return <section className="panel dictionary-panel">
    <div className="panel-heading"><div><span className="kicker">LEXICON</span><h2>音乐词字典</h2></div><span className="meta">{entries.length} WORDS</span></div>
    <div className="dictionary-grid">
      {sorted.map((word) => {
        const examples = examplesByWord.get(word.id) ?? [];
        const displayExamples = examples.length ? examples : [{ word, trackId: null, index: 0, representative: true }];
        const expanded = expandedWordId === word.id;
        return <article key={word.id} className={`word-card ${selectedWordId === word.id ? 'selected' : ''} ${expanded ? 'expanded' : ''}`} style={{ '--word-color': wordColor(word) }}>
          <button className="word-card-main" aria-expanded={expanded} onClick={() => { setExpandedWordId(expanded ? null : word.id); onPlay(word, `dict:${word.id}`); }}>
            <span className="word-top"><span><LevelBadge level={word.level} /><b>{word.id}</b></span><small>L{word.level}</small></span>
            <WordPianoRoll word={word} active={playing?.key === `dict:${word.id}`} progress={playing?.progress} />
            <span className="word-bottom"><span>{word.notes.length} notes</span><span>{word.count}× · {expanded ? '收起' : '样例'}</span></span>
          </button>
          {expanded && <div className="word-examples">
            {displayExamples.map((example, index) => {
              const key = example.representative ? `dict:${word.id}:representative` : `${example.trackId}:${example.index}`;
              return <button key={key} className={playing?.key === key ? 'active' : ''} onClick={() => onPlay(example.word, key, example.representative ? null : { trackId: example.trackId, index: example.index })}>
                <span>{example.representative ? '代表样例' : `${trackNames[example.trackId] ?? example.trackId} · #${example.index + 1}`}</span>
                <WordPianoRoll word={example.word} active={playing?.key === key} progress={playing?.progress} />
              </button>;
            })}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}

function FrequencyChart({ entries, onPlay, playing, selectedWordId, manual = false }) {
  const items = [...entries].sort((a, b) => b.count - a.count).slice(0, 14);
  const max = Math.max(...items.map((item) => item.count), 1);
  return <section className="panel stats-panel">
    <div className="panel-heading"><div>{!manual && <span className="kicker">FREQUENCY</span>}<h2>词频分布</h2></div><ChartBar size={20} /></div>
    <div className="bar-chart">
      {items.map((word) => <button key={word.id} onClick={() => onPlay(word, `stat:${word.id}`)} className={`${playing?.key === `stat:${word.id}` ? 'active' : ''} ${selectedWordId === word.id ? 'selected' : ''}`} style={{ '--word-color': wordColor(word) }}>
        <span className="bar-label">{manual ? word.label : <><LevelBadge level={word.level} />{word.id}</>}</span>
        <WordPianoRoll word={word} active={playing?.key === `stat:${word.id}`} progress={playing?.progress} />
        <span className="bar-track"><i style={{ width: `${Math.max(2, word.count / max * 100)}%`, background: wordColor(word) }} /></span>
        <b>{word.count}</b>
      </button>)}
    </div>
  </section>;
}

function EventTable({ track, sequence, onPlay, playing, selectedWordId, focusedInstanceKey, tpb }) {
  const wordForNote = new Map();
  sequence?.words.forEach((word, index) => word.notes.forEach((note) => wordForNote.set(note.id, { word, index })));
  return <section className="panel table-panel">
    <div className="panel-heading"><div><span className="kicker">EVENT STREAM</span><h2>音乐事件</h2></div><span className="meta">NORMALIZED 0–1</span></div>
    <div className="table-scroll"><table><thead><tr><th>#</th><th>词</th><th>词片段</th><th>音高</th><th>力度</th><th>时长</th><th>Onset</th><th>Δt Prev</th><th>Δt Next</th><th>Δp Prev</th><th>Δp Next</th><th>归一化向量</th><th /></tr></thead>
      <tbody>{track.events.slice(0, 500).map((event, row) => {
        const hit = wordForNote.get(event.id); const key = `${track.id}:${hit?.index}`;
        const target = hit && { trackId: track.id, index: hit.index };
        return <tr key={event.id} className={`${playing?.key === key ? 'playing-row' : ''} ${selectedWordId === hit?.word.id ? 'selected-row' : ''} ${focusedInstanceKey === key ? 'focused-row' : ''}`} style={{ '--word-color': wordColor(hit?.word ?? 0) }}>
          <td>{String(row + 1).padStart(3, '0')}</td><td><span className="token-tag">{hit && <LevelBadge level={wordLevel(hit.word)} />}{hit?.word.id}</span></td><td>{hit && <button className="table-word-roll has-highlight" onClick={() => onPlay(hit.word, key, target)} aria-label={`播放音乐词 ${hit.word.id}，高亮 ${event.name}`}><WordPianoRoll word={hit.word} active={playing?.key === key} progress={playing?.progress} highlightedNoteId={event.id} /></button>}</td><td><b>{event.name}</b> {event.pitch}</td><td>{event.velocity}</td><td>{event.duration}t <small>{(event.duration / tpb).toFixed(2)}b</small></td><td>{event.onset}t</td><td>{event.prevDelta}t</td><td>{event.nextDelta}t</td><td>{event.prevPitchDelta > 0 ? '+' : ''}{event.prevPitchDelta}st</td><td>{event.nextPitchDelta > 0 ? '+' : ''}{event.nextPitchDelta}st</td><td className="vector">{FEATURE_KEYS.map((feature) => event.normalized[feature].toFixed(2)).join(' · ')}</td><td><button className="icon-button" onClick={() => hit && onPlay(hit.word, key, target)} aria-label="播放音乐词"><Play size={13} weight="fill" /></button></td>
        </tr>;
      })}</tbody></table></div>
    {track.events.length > 500 && <p className="table-note">为保证交互流畅，表格显示前 500 个事件；算法仍使用完整轨道。</p>}
  </section>;
}

export default function App() {
  const embedded = new URLSearchParams(window.location.search).has('workspace');
  const [mode, setMode] = useState(() => window.location.hash === '#annotation' ? 'annotation' : 'algorithm');
  const [songs, setSongs] = useState([]);
  const [songId, setSongId] = useState('001');
  const [fileSource, setFileSource] = useState(null);
  const fileInput = useRef(null);
  const [shared, setShared] = useState(null);
  const [reference, setReference] = useState(null);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const algorithmMount = useRef(null);
  const editorMount = useRef(null);
  const algorithmPicker = useRef(null);
  const editorPicker = useRef(null);
  const controls = useRef(null);
  const [midi, setMidi] = useState(null);
  const [algorithmTrackIds, setAlgorithmTrackIds] = useState([]);
  const [editorTrackIds, setEditorTrackIds] = useState([]);
  const selectedTracks = mode === 'algorithm' ? algorithmTrackIds : editorTrackIds;
  const setSelectedTracks = mode === 'algorithm' ? setAlgorithmTrackIds : setEditorTrackIds;
  const [tpb, setTpb] = useState(24);
  const [saturation, setSaturation] = useState(8);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [metric, setMetric] = useState('cosine');
  const [threshold, setThreshold] = useState(.94);
  const [history, setHistory] = useState([]);
  const [roundTarget, setRoundTarget] = useState('');
  const [runningRounds, setRunningRounds] = useState(false);
  const [roundMessage, setRoundMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedWordId, setSelectedWordId] = useState(null);
  const [focusedInstanceKey, setFocusedInstanceKey] = useState(null);
  const [jumpTarget, setJumpTarget] = useState(null);
  const [hiddenLevels, setHiddenLevels] = useState([]);
  const [topWordsOnly, setTopWordsOnly] = useState(false);
  const [parameterFileExists, setParameterFileExists] = useState(false);
  const [parameterBusy, setParameterBusy] = useState('');
  const [parameterMessage, setParameterMessage] = useState('');
  const [annotationTracks, setAnnotationTracks] = useState([]);
  const annotationSourceId = useRef(null);
  const [loadedCategories, setLoadedCategories] = useState([]);
  const [annotationLevel, setAnnotationLevel] = useState(1);
  const [annotationSelection, setAnnotationSelection] = useState(null);
  const [annotationLocation, setAnnotationLocation] = useState(null);
  const [annotationCategory, setAnnotationCategory] = useState(null);
  const [annotationMessage, setAnnotationMessage] = useState('');
  const [annotationHistory, setAnnotationHistory] = useState([]);
  const lastAnnotation = annotationHistory.at(-1);
  const [searchTemplate, setSearchTemplate] = useState(null);
  const [matchLocation, setMatchLocation] = useState(null);
  const [editingAnnotation, setEditingAnnotation] = useState(null);
  const [playSelectionOnSelect, setPlaySelectionOnSelect] = useState(true);
  const [matchParameters, setMatchParameters] = useState(DEFAULT_MATCH_PARAMETERS);
  const [matchScope, setMatchScope] = useState('track');
  const jumpCounter = useRef(0);
  const targetRoundRef = useRef(0);
  const roundRun = useRef(null);
  const lastBpeInputs = useRef(null);
  const annotationTpb = 24;
  const { play, stop, playing } = usePlayer(mode === 'annotation' ? annotationTpb : tpb);

  useEffect(() => window.MusicWordPreview.attachImport(fileInput.current,
    (file) => setFileSource({ file }), setError), []);

  useEffect(() => {
    if (!embedded) return undefined;
    let disposed = false;
    const moduleUrl = new URL('/shared-annotations.mjs', location.origin).href;
    import(/* @vite-ignore */ moduleUrl).then((api) => {
      if (disposed) return;
      setShared(api);
      const loadScore = (document, file, restore = false) => new Promise((resolve, reject) => {
        setFileSource({ file, document, restore, resolve, reject });
      });
      controls.current = {
        algorithm: api.mountAnnotationControls(algorithmMount.current, {
          toolbar: algorithmPicker.current,
          onLoad: loadScore, onChange: setReference,
        }),
        editor: api.mountAnnotationControls(editorMount.current, {
          toolbar: editorPicker.current,
          onLoad: (document, file) => loadScore(document, file, true), editing: true,
        }),
      };
    }).catch((err) => { if (!disposed) setAnnotationMessage(err.message); });
    return () => {
      disposed = true;
      controls.current?.editor.dispose();
      controls.current?.algorithm.dispose();
    };
  }, [embedded]);

  useEffect(() => {
    fetch('./api/songs').then((res) => res.ok ? res.json() : Promise.reject(new Error('无法读取曲目列表')))
      .then((data) => { setSongs(data); if (!data.some((song) => song.id === songId)) setSongId(data[0]?.id ?? ''); })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    fetch('./api/parameters').then((res) => res.ok ? res.json() : Promise.reject())
      .then((data) => setParameterFileExists(Boolean(data.exists)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!songId && !fileSource) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true); setError(''); setSaveMessage(''); stop();
    async function openScore() {
      const file = fileSource?.file;
      if (file?.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的 MIDI 文件');
      const response = file
        ? await fetch(`./api/midi?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal,
        })
        : await fetch(`./api/midi/${encodeURIComponent(fileSource?.catalogId ?? songId)}`, { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'MIDI 解析失败');
      let saved = fileSource?.document;
      if (saved?.schema === 'bpe-music-word-annotation') saved = migrateLegacyAnnotation(saved, data);
      if (!saved && embedded) {
        const response = await fetch(`/api/annotations/${data.sourceId}`, { signal });
        if (response.ok) saved = await response.json();
        else if (response.status !== 404) throw new Error('无法读取该曲目的已保存标注');
      }
      if (signal.aborted) return;
      if (saved && saved.sourceId !== data.sourceId) throw new Error('标注与 MIDI 文件不一致');
      if (saved && !data.catalogId) data.name = saved.song.name;
      const sourceTracks = data.tracks.map((track) => prepareAnnotationTrack(track, annotationTpb / data.sourcePpq));
      const restored = restoreAnnotationTracks(saved, sourceTracks);
      setMidi(data);
      if (annotationSourceId.current !== data.sourceId || fileSource?.restore) {
        annotationSourceId.current = data.sourceId;
        setAnnotationTracks(restored);
        setAnnotationLocation(null);
        setLoadedCategories(saved?.categories ?? []);
      }
      const annotatedIds = (saved?.tracks ?? []).filter((track) =>
        track.layers.some((layer) => layer.words.some((word) => !word.automatic)))
        .map((track) => track.trackId).filter((id) => data.tracks.some((track) => track.id === id));
      const defaultTrack = data.tracks.find((track) => track.name.trim().toUpperCase() === 'MELODY') ?? data.tracks[0];
      const comparisonTrack = fileSource?.document && !fileSource.restore ? annotatedIds[0] : null;
      setAlgorithmTrackIds([comparisonTrack ?? defaultTrack.id]);
      const editorTrackId = annotatedIds.includes(defaultTrack.id) ? defaultTrack.id : annotatedIds[0] ?? defaultTrack.id;
      setEditorTrackIds([editorTrackId]);
      if (fileSource?.restore || !fileSource?.document) setAnnotationLevel(1);
      setAnnotationMessage('');
    }
    openScore().then(() => { if (!signal.aborted) fileSource?.resolve?.(); })
      .catch((err) => {
        if (signal.aborted) return;
        fileSource?.reject?.(err);
        setError(err.message);
      })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => {
      controller.abort();
      fileSource?.reject?.(new Error('已切换乐谱来源。'));
    };
  }, [songId, fileSource, embedded, stop]);

  const referenceByTrack = useMemo(() => {
    const result = new Map();
    if (!midi || !shared || !reference || midi.sourceId !== reference.document.sourceId) return result;
    const scale = tpb / reference.document.timing.sourcePpq;
    for (const track of midi.tracks) {
      const match = shared.referenceTrack(reference, track.signature, track.id);
      const segments = shared.referenceSegments(reference, match);
      const window = shared.referenceWindow(segments);
      if (!window) continue;
      const [start] = window;
      const manual = segments.map((segment) => ({
        ...segment, notes: segment.notes.map((note) => shared.quantizedNote(
          { ...note, ticks: note.ticks - start }, scale, Math.round, true,
        )),
      }));
      const [, , evaluationEnd] = shared.noteBox(manual.flatMap(({ notes }) => notes));
      result.set(track.id, { window, manual, evaluationEnd });
    }
    return result;
  }, [midi, reference, shared, tpb]);
  const comparing = Boolean(reference && midi?.sourceId === reference.document.sourceId);
  const preparedTracks = useMemo(() => {
    if (!midi) return [];
    const chosen = [];
    for (const track of midi.tracks) {
      if (!algorithmTrackIds.includes(track.id)) continue;
      const evaluation = referenceByTrack.get(track.id);
      if (comparing && !evaluation) continue;
      const notes = evaluation ? track.notes.flatMap((note) => {
        const clipped = shared.clipMidiNote(note, evaluation.window);
        if (!clipped) return [];
        const ticks = clipped.ticks - evaluation.window[0];
        return Math.round(ticks * (tpb / midi.sourcePpq)) < evaluation.evaluationEnd ? [{ ...clipped, ticks }] : [];
      }) : track.notes;
      const events = makeEvents(notes, midi.sourcePpq, tpb, saturation);
      if (evaluation) {
        for (const event of events) event.duration = Math.min(event.duration, evaluation.evaluationEnd - event.onset);
      }
      if (events.length) chosen.push({ ...track, events, evaluationEnd: evaluation?.evaluationEnd });
    }
    return chosen.length ? normalizeTracks(chosen) : [];
  }, [midi, algorithmTrackIds, tpb, saturation, comparing, referenceByTrack, shared]);
  const annotationSourceTracks = useMemo(() => midi?.tracks.filter((track) => editorTrackIds.includes(track.id))
    .map((track) => prepareAnnotationTrack(track, annotationTpb / midi.sourcePpq)) ?? [], [midi, editorTrackIds]);
  useEffect(() => {
    setMatchLocation(null);
  }, [searchTemplate, annotationSourceTracks, annotationTracks, matchParameters, matchScope, mode]);

  useEffect(() => {
    if (mode !== 'algorithm') return;
    const inputs = [preparedTracks, weights, metric, threshold];
    if (lastBpeInputs.current?.every((value, index) => value === inputs[index])) return;
    lastBpeInputs.current = inputs;
    const rebuilt = buildBpeHistory(preparedTracks, targetRoundRef.current, weights, metric, threshold);
    targetRoundRef.current = rebuilt.at(-1)?.round ?? 0;
    setHistory(rebuilt);
    setRoundMessage('');
    setHiddenLevels([]);
    setSelectedWordId(null); setFocusedInstanceKey(null); setJumpTarget(null); stop();
  }, [mode, preparedTracks, weights, metric, threshold, stop]);
  useEffect(() => () => roundRun.current?.abort(), [mode, loading, preparedTracks, weights, metric, threshold]);
  useEffect(() => { stop(); }, [mode, stop]);
  useEffect(() => {
    if (!embedded) return undefined;
    function receive(event) {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      if (event.data?.type === 'musicword:deactivate') stop();
      if (event.data?.type === 'musicword:bpe-mode' && ['algorithm', 'annotation'].includes(event.data.mode)) {
        setMode(event.data.mode);
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [embedded, stop]);
  useEffect(() => {
    setAnnotationSelection(null);
    setAnnotationCategory(null);
    setAnnotationHistory([]);
    setSearchTemplate(null);
    setEditingAnnotation(null);
    setAnnotationMessage('');
  }, [annotationSourceTracks]);
  const state = history.at(-1);
  const entries = state ? Object.values(state.dictionary) : [];
  useEffect(() => {
    const evaluation = controls.current?.algorithm;
    if (!reference || !shared || !evaluation || mode !== 'algorithm') return;
    if (loading || error) {
      evaluation.setScore(loading ? '正在读取乐谱…' : '乐谱读取失败，无法比对。');
      return;
    }
    if (midi?.sourceId !== reference.document.sourceId) {
      evaluation.setScore('当前 MIDI 与所加载的标注不同。');
      return;
    }
    if (!state) return;
    const totals = { matches: 0, manual: 0, predicted: 0, covered: 0 };
    const comparisons = [];
    for (const sequence of state.sequences) {
      const manual = referenceByTrack.get(sequence.trackId)?.manual ?? [];
      if (!manual.length) continue;
      const predictions = sequence.words.map((word) => ({
        categoryId: word.id,
        noteIds: word.notes.map((note) => note.id),
        box: shared.noteBox(word.notes.map(({ onset, duration, pitch }) => ({
          start: onset, end: onset + duration, pitch,
        }))),
      }));
      const counts = shared.fragmentCounts(manual.map((segment) => segment.noteIds), predictions.map((word) => word.noteIds));
      for (const key of Object.keys(totals)) totals[key] += counts[key];
      const track = preparedTracks.find(({ id }) => id === sequence.trackId);
      if (track) comparisons.push(shared.comparisonTrack(track.events, manual, predictions));
    }
    evaluation.setScore(shared.formatScores(totals, `第 ${state.round} 轮顶层`));
    if (comparisons.length) evaluation.compare(comparisons);
  }, [error, loading, midi, mode, preparedTracks, reference, referenceByTrack, shared, state]);
  const currentRound = state?.round ?? 0;
  const canRunRounds = !loading && !error && state && preparedTracks.length && !runningRounds;
  const runRounds = async (target) => {
    if (!canRunRounds || roundRun.current || !Number.isSafeInteger(target) || target <= currentRound) return;
    const controller = new AbortController();
    const batch = target > currentRound + 1;
    roundRun.current = controller;
    if (batch) setRunningRounds(true);
    setRoundMessage('');
    try {
      const completed = [];
      let current = state;
      while (current.round < target) {
        if (batch) await new Promise((resolve) => setTimeout(resolve, 0));
        if (controller.signal.aborted) return;
        const next = bpeStep(current, weights, metric, threshold);
        if (next === current) break;
        completed.push(next);
        current = next;
      }
      if (completed.length) {
        targetRoundRef.current = current.round;
        setHistory([...history, ...completed]);
      }
      if (current.round < target) setRoundMessage(`已完成第 ${current.round} 轮，剩余词对无法继续合并。`);
    } finally {
      roundRun.current = null;
      if (batch) setRunningRounds(false);
    }
  };
  const undo = () => {
    if (roundRun.current || history.length <= 1) return;
    const next = history.slice(0, -1);
    targetRoundRef.current = next.at(-1)?.round ?? 0;
    setHistory(next);
    setRoundMessage('');
  };
  const playWord = useCallback((word, key, target = null) => {
    setSelectedWordId(word.id);
    setFocusedInstanceKey(target ? key : null);
    if (target) {
      const level = wordLevel(word);
      setHiddenLevels((old) => old.filter((item) => item !== level));
      setJumpTarget({ ...target, nonce: ++jumpCounter.current });
    }
    play(word, key, !key.startsWith('track:'));
  }, [play]);
  const trackNames = useMemo(() => Object.fromEntries((midi?.tracks ?? []).map((track) => [track.id, track.name])), [midi]);
  const availableLevels = useMemo(() => [...new Set(entries.map((word) => word.level))].sort((a, b) => a - b), [entries]);
  const visibleLevels = useMemo(() => availableLevels.filter((level) => !hiddenLevels.includes(level)), [availableLevels, hiddenLevels]);
  const toggleLevel = useCallback((level) => setHiddenLevels((old) => old.includes(level) ? old.filter((item) => item !== level) : [...old, level]), []);
  const currentParameters = useMemo(() => ({ tpb, saturation, metric, threshold, weights }), [tpb, saturation, metric, threshold, weights]);
  useLayoutEffect(() => {
    const validate = (values, page) => {
      if (page === 'annotation') {
        if (!values?.matchParameters || !['track', 'visible'].includes(values.matchScope) ||
            !Number.isInteger(values.annotationLevel) || values.annotationLevel < 0 ||
            typeof values.playSelectionOnSelect !== 'boolean') throw new Error('标注参数方案无效。');
        const normalized = normalizeMatchParameters(values.matchParameters);
        if (Object.keys(normalized).some((key) => normalized[key] !== values.matchParameters[key])) {
          throw new Error('辅助标注参数超出允许范围，请检查参数方案。');
        }
      } else {
        normalizeParameterFile({ schemaVersion: 1, parameters: values?.parameters });
        if (typeof values.topWordsOnly !== 'boolean' ||
            !(values.roundTarget === '' || (Number.isSafeInteger(Number(values.roundTarget)) && Number(values.roundTarget) > 0))) {
          throw new Error('BPE 显示或轮数参数无效。');
        }
      }
    };
    const api = {
      validate,
      snapshot(page) {
        const values = page === 'annotation'
          ? { matchParameters, matchScope, annotationLevel, playSelectionOnSelect }
          : { parameters: currentParameters, topWordsOnly, roundTarget };
        validate(values, page);
        return structuredClone(values);
      },
      apply(values, page) {
        validate(values, page);
        stop();
        if (page === 'annotation') {
          setMatchParameters(values.matchParameters); setMatchScope(values.matchScope);
          setAnnotationLevel(values.annotationLevel); setPlaySelectionOnSelect(values.playSelectionOnSelect);
        } else {
          const p = normalizeParameterFile({ schemaVersion: 1, parameters: values.parameters }).parameters;
          setTpb(p.tpb); setSaturation(p.saturation); setMetric(p.metric); setThreshold(p.threshold); setWeights(p.weights);
          setTopWordsOnly(values.topWordsOnly); setRoundTarget(values.roundTarget);
        }
      },
    };
    window.MusicWordParameters = api;
    return () => { if (window.MusicWordParameters === api) delete window.MusicWordParameters; };
  });
  const saveParameters = async () => {
    setParameterBusy('save'); setParameterMessage('');
    try {
      const response = await fetch('./api/parameters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: currentParameters }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '参数服务没有接受该文件');
      setParameterFileExists(true);
      setParameterMessage(`已保存到 ${data.filename}`);
    } catch (err) {
      setParameterMessage(err.message || '保存失败，请确认数据服务正在运行');
    } finally { setParameterBusy(''); }
  };
  const loadParameters = async () => {
    setParameterBusy('load'); setParameterMessage('');
    try {
      const response = await fetch('./api/parameters');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '参数文件读取失败');
      if (!data.exists) { setParameterFileExists(false); throw new Error(`项目目录中还没有 ${PARAMETER_FILENAME}`); }
      const { parameters } = normalizeParameterFile(data.document);
      setTpb(parameters.tpb); setSaturation(parameters.saturation); setMetric(parameters.metric);
      setThreshold(parameters.threshold); setWeights(parameters.weights);
      setParameterMessage(`已从 ${data.filename} 加载并重新计算`);
    } catch (err) {
      setParameterMessage(err.message || '加载失败，请检查参数文件格式');
    } finally { setParameterBusy(''); }
  };
  const visibleAnnotationTracks = useMemo(() => annotationTracks.filter((track) => editorTrackIds.includes(track.trackId)),
    [annotationTracks, editorTrackIds]);
  const displayedAnnotationTrack = visibleAnnotationTracks.find((track) => track.trackId === annotationSelection?.trackId)
    ?? visibleAnnotationTracks.find((track) => track.trackId === annotationLocation?.trackId)
    ?? visibleAnnotationTracks[0] ?? annotationTracks[0];
  const annotationLayers = displayedAnnotationTrack?.layers ?? [];
  const annotationMaxLevel = Math.max(0, annotationLayers.length - 1);
  const currentAnnotationLayer = annotationLayers[annotationLevel];
  useEffect(() => {
    if (annotationLayers.length && annotationLevel > annotationMaxLevel) setAnnotationLevel(Math.max(0, annotationMaxLevel - 1));
  }, [annotationLayers.length, annotationLevel, annotationMaxLevel]);
  const annotationCoverage = visibleAnnotationTracks.reduce((total, track) => {
    const coverage = layerCoverage(track, annotationLevel);
    return { covered: total.covered + coverage.covered, total: total.total + coverage.total };
  }, { covered: 0, total: 0 });
  const parentLevel = annotationSelection && annotationLayers[annotationSelection.level + 1] ? annotationSelection.level + 1 : null;
  const dictionaryLevel = parentLevel ?? annotationLevel;
  const needsParentLayer = parentLevel != null && annotationLayers[parentLevel]?.role === 'top';
  const annotationCategories = useMemo(() => [...new Map(
    [...ANNOTATION_CATEGORIES, ...loadedCategories].map((category) => [category.id, category]),
  ).values()], [loadedCategories]);
  const annotationView = useMemo(
    () => buildAnnotationView(needsParentLayer ? [] : visibleAnnotationTracks, annotationSourceTracks, dictionaryLevel, annotationCategories),
    [needsParentLayer, visibleAnnotationTracks, annotationSourceTracks, dictionaryLevel, annotationCategories],
  );
  const canAggregate = parentLevel != null && Boolean(annotationCategory)
    && (!editingAnnotation || (editingAnnotation.trackId === annotationSelection?.trackId && editingAnnotation.level === parentLevel));
  const managedAnnotationView = useMemo(
    () => buildAnnotationView(visibleAnnotationTracks, annotationSourceTracks, annotationLevel, annotationCategories),
    [visibleAnnotationTracks, annotationSourceTracks, annotationLevel, annotationCategories],
  );
  const deletionSelection = annotationSelection?.kind === 'tree' ? annotationSelection : annotationLocation;
  const deletionTrack = visibleAnnotationTracks.find((track) => track.trackId === deletionSelection?.trackId);
  const deletionIds = new Set(deletionSelection?.sourceSegmentIds ?? [deletionSelection?.segmentId]);
  const deletionTargets = deletionTrack?.layers[deletionSelection.level]?.segments
    .filter((segment) => !segment.automatic && deletionIds.has(segment.id))
    .map((segment) => ({ trackId: deletionTrack.trackId, segmentId: segment.id })) ?? [];
  const rememberAnnotation = () => setAnnotationHistory((old) => [...old.slice(-99), { tracks: annotationTracks, level: annotationLevel }]);
  const clearAnnotationSelection = () => {
    setAnnotationSelection(null);
    setAnnotationLocation(null);
    setMatchLocation(null);
    setAnnotationCategory(null);
    setAnnotationMessage('');
  };
  const locateAnnotation = ({ trackId, segmentId, level, categoryId }) => {
    clearAnnotationSelection();
    setEditingAnnotation(null);
    setAnnotationLevel(level);
    setAnnotationLocation({ trackId, segmentId, level });
    setSelectedWordId(categoryId);
  };
  const openSimilaritySearch = (word, trackId) => {
    if (!word.notes.length || word.automatic) return;
    setSearchTemplate({ notes: word.notes, trackId, segmentId: word.instanceId, level: word.level, categoryId: word.id });
    setEditingAnnotation(null);
    clearAnnotationSelection();
  };
  const locateMatch = (candidate, color) => {
    setAnnotationLocation(null);
    setMatchLocation({ ...candidate, color });
  };
  const acceptSimilarSegments = (candidates, template, parameters) => {
    const result = acceptAnnotationMatches(annotationTracks, template.level, candidates, template.categoryId, template, parameters);
    if (!result.added.length) return '候选已标注或与当前结果冲突，请重新查找。';
    rememberAnnotation();
    stop();
    setAnnotationTracks(result.tracks);
    setSearchTemplate(null);
    setSaveMessage('');
    locateAnnotation({ ...result.added[0], level: template.level, categoryId: template.categoryId });
    setAnnotationMessage(`已接受 ${result.added.length} 个片段，标为词类 ${template.categoryId}。可在标注结果中筛选「辅助标注」修改或删除，也可撤销整批。`);
  };
  const deleteManagedAnnotations = (targets, level = annotationLevel) => {
    if (!targets.length) return;
    rememberAnnotation();
    stop();
    setAnnotationTracks(deleteAnnotationSegments(annotationTracks, level, targets));
    setSearchTemplate(null); setEditingAnnotation(null); clearAnnotationSelection();
    setSaveMessage('');
    setAnnotationMessage(`已删除 ${targets.length} 个标注，可撤销。`);
  };
  const deleteSelectedAnnotations = () => deleteManagedAnnotations(deletionTargets, deletionSelection.level);
  const reclassifyAnnotations = (targets, categoryId) => {
    if (!targets.length) return;
    rememberAnnotation();
    setAnnotationTracks(annotationTracks.map((track) => targets.filter((target) => target.trackId === track.trackId)
      .reduce((next, target) => editAnnotation(next, annotationLevel, target.segmentId, { categoryId }), track)));
    setSearchTemplate(null); setEditingAnnotation(null); clearAnnotationSelection();
    setSelectedWordId(categoryId); setSaveMessage('');
    setAnnotationMessage(`已将 ${targets.length} 个标注改为词类 ${categoryId}，可撤销。`);
  };
  const editManagedAnnotation = ({ word, trackId, segmentId }) => {
    setEditingAnnotation({ trackId, segmentId, level: word.level, categoryId: word.id });
    setSearchTemplate(null); setAnnotationSelection(null); setAnnotationLocation(null); setAnnotationCategory(word.id);
    setAnnotationLevel(word.level === 1 ? 1 : word.level - 1);
    setAnnotationMessage(`正在编辑词类 ${word.id}：重新选择范围后点击「保存修改」。`);
    document.querySelector('.annotation-roll-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const selectAnnotationNodes = (trackId, level, ids, toggle, kind = 'tree', audition = true) => {
    const track = annotationTracks.find((item) => item.trackId === trackId);
    const layer = track?.layers[level];
    if (!layer) return;

    setAnnotationLocation(null);
    setMatchLocation(null);
    setAnnotationLevel(kind === 'tree' ? level : 1);
    const sameLayer = annotationSelection?.trackId === trackId && annotationSelection.level === level && annotationSelection.kind === kind;
    const nextIds = new Set(toggle && sameLayer ? annotationSelection.sourceSegmentIds : []);
    for (const id of ids) {
      if (toggle && nextIds.has(id)) nextIds.delete(id);
      else nextIds.add(id);
    }
    const nodes = layer.segments.filter((segment) => nextIds.has(segment.id));
    if (!nodes.length) {
      clearAnnotationSelection();
      return;
    }
    const noteIds = [...new Set(nodes.flatMap((segment) => segment.noteIds))];
    setAnnotationSelection({ trackId, level, kind, noteIds, sourceSegmentIds: nodes.map((node) => node.id) });
    const parent = track.layers[level + 1];
    const counts = parent?.role === 'manual' ? annotationCategoryCounts(visibleAnnotationTracks, level + 1) : {};
    setAnnotationCategory(parent ? (editingAnnotation?.categoryId || (sameLayer && annotationCategory)) || nextEmptyAnnotationCategory(annotationCategories, counts) : null);
    if (audition && playSelectionOnSelect) {
      const sourceTrack = annotationSourceTracks.find((item) => item.id === trackId);
      const selectionWord = buildAnnotationSelectionWord(sourceTrack, noteIds);
      if (selectionWord) play(selectionWord, `annotation-selection:${trackId}`, false);
    }
    setAnnotationMessage(parent ? '' : '已选中整首乐曲');
  };
  const confirmAnnotation = () => {
    if (!canAggregate) return;
    const { trackId, level, sourceSegmentIds } = annotationSelection;
    if (editingAnnotation) {
      rememberAnnotation();
      setAnnotationTracks(annotationTracks.map((track) => track.trackId === trackId ? editAnnotation(track, editingAnnotation.level, editingAnnotation.segmentId, {
        noteIds: annotationSelection.noteIds, sourceSegmentIds, categoryId: annotationCategory,
      }) : track));
      setAnnotationLevel(editingAnnotation.level); setEditingAnnotation(null); setSearchTemplate(null);
      setSelectedWordId(annotationCategory); setSaveMessage('');
      clearAnnotationSelection(); setAnnotationMessage('已修改标注范围，可撤销。');
      return;
    }
    const result = aggregateAnnotationNodes(annotationTracks, trackId, level, sourceSegmentIds, annotationCategory, `words-${Date.now()}`);
    if (result.error) { setAnnotationMessage(result.error); return; }
    rememberAnnotation();
    setAnnotationTracks(result.tracks);
    setAnnotationLevel(result.parentLevel);
    setSearchTemplate(null);
    setSelectedWordId(result.segment.categoryId); setSaveMessage('');
    clearAnnotationSelection();
    setAnnotationMessage(result.replaced ? `已将 L${result.parentLevel} 的原标注改为词类 ${result.segment.categoryId}`
      : `已在 L${result.parentLevel} 生成词类 ${result.segment.categoryId} 节点`);
  };
  const undoLastAnnotation = () => {
    if (!lastAnnotation) return;
    setAnnotationTracks(lastAnnotation.tracks);
    setAnnotationLevel(lastAnnotation.level);
    setAnnotationHistory((old) => old.slice(0, -1));
    setSearchTemplate(null); setEditingAnnotation(null);
    clearAnnotationSelection();
    setSaveMessage('');
    setAnnotationMessage('已撤销上次标注');
  };
  useEffect(() => {
    if (mode !== 'annotation') return undefined;
    const onKeyDown = (event) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (isEditable || event.repeat || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z' && lastAnnotation) {
        event.preventDefault();
        undoLastAnnotation();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape' && (annotationSelection || annotationLocation || matchLocation)) {
        event.preventDefault();
        clearAnnotationSelection();
        return;
      }
      if (/^[1-8]$/.test(event.key)) {
        event.preventDefault();
        const category = annotationCategories[Number(event.key) - 1];
        setAnnotationCategory(category.id);
        return;
      }
      const button = target instanceof Element && target.closest('button');
      if (!event.shiftKey && (event.key === 'Enter' || event.key === ' ') && canAggregate
        && (!button || button.classList.contains('category-slot-main'))) {
        event.preventDefault();
        confirmAnnotation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canAggregate, annotationCategories, annotationCategory, annotationSelection, annotationLocation, matchLocation, annotationTracks, annotationLevel, editingAnnotation, lastAnnotation, mode]);
  const saveAnnotations = async (download = false) => {
    setSavingAnnotation(true);
    setSaveMessage('');
    try {
      const exportDocument = buildAnnotationExport({ midi, tracks: annotationTracks,
        categories: annotationCategories, tpb: annotationTpb });
      const file = fileSource?.file ?? await (async () => {
        const response = await fetch(`./api/midi/${encodeURIComponent(midi.catalogId)}?raw=1`);
        if (!response.ok) throw new Error('无法读取标注所用的 MIDI');
        return response.blob();
      })();
      exportDocument.fileName = fileSource?.file?.name ?? catalogSong?.file ?? `${midi.catalogId}.mid`;
      exportDocument.midi = shared ? await shared.fileBase64(file) : await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if (embedded && !download) {
        await shared.annotationRequest('/' + midi.sourceId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportDocument),
        });
        setSaveMessage('已保存到共享标注库。可在算法页加载。');
        controls.current.editor.refresh();
        controls.current.algorithm.refresh();
      } else {
        const blob = new Blob([`${JSON.stringify(exportDocument, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `musicword-${midi.name.replace(/\.midi?$/i, '')}-annotation.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setSaveMessage(`已导出 ${anchor.download}`);
      }
    } catch (error) {
      setSaveMessage(error.message || '标注保存失败');
    } finally {
      setSavingAnnotation(false);
    }
  };
  const importAnnotations = async (file) => {
    setSaveMessage('');
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('请选择不超过 30 MB 的标注 JSON');
      const document = JSON.parse(await file.text());
      if (document?.schemaVersion !== 1) throw new Error('不支持此标注文件版本');
      if (document.schema === 'musicword-annotation' && typeof document.midi === 'string') {
        setFileSource({ file: shared.annotationMidiFile(document), document, restore: true });
      } else if (document.schema === 'bpe-music-word-annotation' && songs.some((song) => song.id === document.song?.id)) {
        setFileSource({ catalogId: document.song.id, document, restore: true });
      } else {
        throw new Error('无法识别标注文件或找不到对应的 POP909 曲目');
      }
    } catch (error) {
      setSaveMessage(error.message || '无法读取标注文件');
    }
  };
  const playAnnotationWord = useCallback((word, key) => {
    setSelectedWordId(word.id);
    setFocusedInstanceKey(null);
    play(word, key, !key.startsWith('track:') && !key.startsWith('annotation-roll:'));
  }, [play]);

  const tpbParameter = { label: '全局 TPB', value: tpb, min: 6, max: 96, onChange: setTpb };
  const saturationParameter = { label: '相对时间饱和', value: saturation, min: 1, max: 32, onChange: setSaturation };
  const thresholdParameter = { label: '匹配阈值', value: threshold, min: .5, max: 1, step: .01, onChange: setThreshold };
  const weightParameters = Object.fromEntries(FEATURE_KEYS.map((key) => [key, {
    label: `${FEATURE_LABELS[key]}权重`, value: weights[key], min: 0, max: 2, step: .05,
    onChange: (value) => setWeights((old) => ({ ...old, [key]: value })),
  }]));

  const requestedRound = Number(roundTarget);
  const roundControls = mode === 'algorithm' && <div className="bpe-round-controls" role="group" aria-label="BPE 轮次控制">
    <button type="button" className="secondary-button" onClick={undo} disabled={!canRunRounds || !currentRound}><ArrowCounterClockwise size={16} />撤销一轮</button>
    <button type="button" className="primary-button" onClick={() => runRounds(currentRound + 1)} disabled={!canRunRounds}><SkipForward size={17} weight="fill" />运行第 {currentRound + 1} 轮</button>
    <form className="bpe-round-target" onSubmit={(event) => { event.preventDefault(); runRounds(requestedRound); }}>
      <input type="number" min={currentRound + 1} step={1} inputMode="numeric" required aria-label="目标轮次"
        placeholder="N" value={roundTarget} onChange={(event) => setRoundTarget(event.target.value)} disabled={!canRunRounds} />
      <button type="submit" className="secondary-button" disabled={!canRunRounds || !Number.isSafeInteger(requestedRound) || requestedRound <= currentRound}>
        {runningRounds ? '运行中…' : '运行至 N 轮'}
      </button>
    </form>
  </div>;
  const toolbarSlot = embedded ? window.frameElement?.ownerDocument.getElementById('bpe-round-slot') : null;
  const sourceSlot = embedded ? window.frameElement?.ownerDocument.getElementById('bpe-source-slot') : null;
  const localToolbar = !embedded || (!toolbarSlot && mode === 'algorithm');
  const catalogSongLabel = (song) => song.collection === 'classical' || song.name === song.id ? song.name : `${song.id} · ${song.name}`;
  const catalogSong = songs.find((song) => song.id === midi?.catalogId);
  const catalogGroups = [
    ['经典曲目', songs.filter((song) => song.collection === 'classical')],
    ['POP909 曲目', songs.filter((song) => song.collection !== 'classical')],
  ];
  const annotatedSong = songs.find((song) => song.id === fileSource?.document?.song?.id);
  const importedLabel = annotatedSong ? `${catalogSongLabel(annotatedSong)}（标注）` :
    fileSource?.document?.song?.name ?? fileSource?.file?.name;
  const midiPicker = <select className="workspace-midi-picker" aria-label="加载 MIDI"
    value={fileSource?.file ? '' : fileSource?.catalogId ?? songId} disabled={savingAnnotation} onChange={(event) => {
      setFileSource(null);
      setSongId(event.target.value);
    }}>
    <option value="" hidden>{importedLabel ?? '选择曲目'}</option>
    {catalogGroups.map(([label, group]) => group.length > 0 && <optgroup key={label} label={label}>
      {group.map((song) => <option key={song.id} value={song.id}>{catalogSongLabel(song)}</option>)}
    </optgroup>)}
  </select>;
  const sourceControls = <>
    <div ref={algorithmPicker} hidden={mode !== 'algorithm'} />
    <div ref={editorPicker} hidden={mode !== 'annotation'} />
    <div className="workspace-midi-source">
      {sourceSlot ? <label className="workspace-midi-control"><span>加载 MIDI</span>{midiPicker}</label> : midiPicker}
      <button type="button" className="workspace-midi-upload" title="导入 MIDI 或 MusicXML"
        disabled={savingAnnotation} onClick={() => fileInput.current.click()}>上传文件</button>
    </div>
  </>;

  return <div className={`app-shell${embedded && !localToolbar ? ' embedded' : ''}`}>
    {toolbarSlot && createPortal(roundControls, toolbarSlot)}
    {sourceSlot && createPortal(sourceControls, sourceSlot)}
    {localToolbar && <header className={`topbar ${mode}-mode`}>
      {embedded ? roundControls : <>
      <div className="brand"><span className="brand-mark"><Waveform size={22} weight="bold" /></span><span>{mode === 'algorithm' ? <><b>BPE MUSIC WORD</b><small>POP909 EXPERIMENT LAB</small></> : <b>音乐词标注</b>}</span></div>
      <div className="mode-switch" role="group" aria-label="工作模式">
        <button className={mode === 'algorithm' ? 'active' : ''} onClick={() => setMode('algorithm')}><Robot size={15} />算法模式</button>
        <button className={mode === 'annotation' ? 'active' : ''} onClick={() => setMode('annotation')}><PencilSimple size={15} />标注模式</button>
      </div>
      {mode === 'algorithm' && <div className="header-stats"><span><small>DATASET</small><b>{songs.length || '…'} songs</b></span><span><small>GLOBAL TPB</small><b>{tpb}</b></span><span><small>ROUND</small><b>{state?.round ?? 0}</b></span></div>}
      {roundControls}
      <button className="playback-stop" onClick={stop} disabled={!playing}>{playing ? <Pause size={16} weight="fill" /> : <SpeakerHigh size={16} />} {playing ? '停止播放' : '音频待命'}</button>
      </>}
    </header>}

    <main>
      <aside className="sidebar">
        <div className="side-section">
          <div className="side-title"><span><Stack size={17} /> 数据源</span></div>
          {!sourceSlot && sourceControls}
          {embedded && mode === 'algorithm' && songs.length > 0 && <p className="source-meta">数据集共 {songs.length} 首曲目</p>}
          <input ref={fileInput} type="file" hidden accept=".mid,.midi,.xml,.musicxml,.mxl" disabled={savingAnnotation} />
          {mode === 'annotation' && shared && <label className="midi-upload">导入标注 JSON<input type="file" accept=".json" disabled={savingAnnotation} onChange={(event) => {
            const file = event.currentTarget.files[0];
            if (file) importAnnotations(file);
            event.currentTarget.value = '';
          }} /></label>}
          {midi && <><p className="source-meta">源 PPQ {midi.sourcePpq} · {midi.tracks.length} 条有效轨道</p><TrackPicker tracks={midi.tracks} selected={selectedTracks} onChange={setSelectedTracks} /></>}
        </div>
        {embedded && <div className="side-section" hidden={mode !== 'annotation'} ref={editorMount} />}
        {mode === 'algorithm' && <div className="side-section">
          <div className="side-title"><span><GearSix size={17} /> 事件参数</span></div>
          <Control {...tpbParameter} />
          <Control {...saturationParameter} suffix=" 拍" />
        </div>}
        {mode === 'algorithm' && <div className="side-section">
          <div className="side-title"><span><Flask size={17} /> 相似度实验</span></div>
          <label className="select-label">相似度方法
            <select value={metric} onChange={(event) => setMetric(event.target.value)}>
              {Object.entries(METRIC_LABELS).map(([value, label]) => <option key={value} value={value}>{label} + DTW</option>)}
            </select>
            <CaretDown size={14} />
          </label>
          <Control {...thresholdParameter} />
          <div className="weight-list">{FEATURE_KEYS.map((key) => <Control key={key} {...weightParameters[key]} />)}</div>
          <div className="parameter-file-actions">
            <div>
              <button className="parameter-button" onClick={saveParameters} disabled={Boolean(parameterBusy)}><FloppyDisk size={15} />{parameterBusy === 'save' ? '保存中…' : '保存参数'}</button>
              <button className="parameter-button" onClick={loadParameters} disabled={Boolean(parameterBusy) || !parameterFileExists}><FolderOpen size={15} />{parameterBusy === 'load' ? '加载中…' : '加载参数'}</button>
            </div>
            <p className={parameterMessage && !parameterMessage.startsWith('已') ? 'parameter-message error' : 'parameter-message'} aria-live="polite">{parameterMessage || `项目目录 / ${PARAMETER_FILENAME}`}</p>
          </div>
        </div>}
        {mode === 'annotation' && <div className="side-section annotation-guide">
          <div className="side-title"><span><PencilSimple size={17} /> 标注流程</span></div>
          <ol>
            <li><b>选择节点</b><span>在层级树点选或框选同层节点，字典会切到父节点所在层。</span></li>
            <li><b>聚合</b><span>选择词类并点击「聚合」，在上方一层生成父节点。音符和节点可以重复使用。</span></li>
          </ol>
          <div className="layer-map">{[...annotationLayers].map((layer, level) => ({ layer, level })).reverse().map(({ layer, level }, index) => <div key={layer.id} className="layer-map-row"><span className={annotationLevel === level ? 'active' : ''}>L{level} {layer.name}</span>{index < annotationLayers.length - 1 && <i />}</div>)}</div>
        </div>}
      </aside>

      <div className="workspace">
        <section className="hero-strip">
          <div>{mode === 'algorithm' ? <h1>从事件流中发现<br /><em>重复的音乐语汇</em></h1> : <>
            <h1>人工音乐词标注</h1>
            {midi && <p className="annotation-song-title">{midi.catalogId ? catalogSongLabel(catalogSong ?? midi) : midi.name}</p>}
          </>}</div>
          {mode === 'algorithm' ? <div className="algorithm-actions">
            {embedded && <p className="algorithm-round">当前轮次 <b>{state?.round ?? 0}</b></p>}
            <p>每轮聚类相似的相邻词对，合并最高频候选。参数更改后会从初始层自动重算到当前轮次，保证实验可复现。</p>
            <p className="round-status" role="status">{roundMessage}</p>
          </div> : <div className="annotation-actions">
            <div className="annotation-progress"><span><b>L{annotationLevel}</b>{currentAnnotationLayer?.name ?? '音乐词层'}</span><span>{annotationCoverage.covered} / {annotationCoverage.total} 音符</span><i><span style={{ width: `${annotationCoverage.total ? annotationCoverage.covered / annotationCoverage.total * 100 : 0}%` }} /></i></div>
            <div className="annotation-nav">
              <SelectionPlaybackToggle checked={playSelectionOnSelect} onChange={setPlaySelectionOnSelect} />
              <button className="primary-button" onClick={() => saveAnnotations()} disabled={loading || Boolean(error) || !midi || savingAnnotation || (embedded && !shared)}><FloppyDisk size={17} />{savingAnnotation ? '保存中…' : '保存标注'}</button>
              {embedded && <button className="secondary-button" onClick={() => saveAnnotations(true)} disabled={loading || Boolean(error) || !midi || savingAnnotation}><DownloadSimple size={17} />导出 JSON</button>}
            </div>
            <output className="annotation-save-status" aria-live="polite">{saveMessage}</output>
          </div>}
        </section>

        {mode === 'annotation' && <div className="annotation-shortcuts" aria-labelledby="annotation-shortcuts-title">
          <b id="annotation-shortcuts-title">快捷键</b>
          <ul>
            <li><kbd>1–8</kbd> 选词类</li>
            <li><kbd>Enter</kbd><kbd>空格</kbd> 聚合或确认</li>
            <li><kbd>Esc</kbd> 清除选择</li>
            <li><kbd>Ctrl/⌘ + Z</kbd> 撤销</li>
          </ul>
        </div>}

        {mode === 'algorithm' && <BpePseudocode
          tpbParameter={tpbParameter} saturationParameter={saturationParameter}
          thresholdParameter={thresholdParameter} weightParameters={weightParameters}
          metric={metric} setMetric={setMetric}
        />}
        {error && <div className="state-message error" role="alert"><b>无法读取数据</b><span>{error}</span></div>}
        {loading && <div className="skeleton"><i /><i /><i /></div>}
        {!loading && !error && !selectedTracks.length && <div className="state-message"><b>请选择至少一条轨道</b></div>}
        {embedded && <div className="panel shared-evaluation-panel" hidden={mode !== 'algorithm'} ref={algorithmMount} />}
        {mode === 'algorithm' && !loading && state && <>
          {preparedTracks.map((track) => <PianoRoll key={track.id} track={track} sequence={state.sequences.find((sequence) => sequence.trackId === track.id)} history={history} tpb={tpb} onPlay={playWord} playing={playing} selectedWordId={selectedWordId} focusedInstanceKey={focusedInstanceKey} jumpTarget={jumpTarget} levels={availableLevels} visibleLevels={visibleLevels} onToggleLevel={toggleLevel} topWordsOnly={topWordsOnly} onTopWordsOnlyChange={setTopWordsOnly} referenceSegments={referenceByTrack.get(track.id)?.manual} />)}
          <div className="analysis-grid"><Dictionary entries={entries} sequences={state.sequences} trackNames={trackNames} onPlay={playWord} playing={playing} selectedWordId={selectedWordId} /><FrequencyChart entries={entries} onPlay={playWord} playing={playing} selectedWordId={selectedWordId} /></div>
          {preparedTracks.map((track) => <EventTable key={track.id} track={track} sequence={state.sequences.find((sequence) => sequence.trackId === track.id)} onPlay={playWord} playing={playing} selectedWordId={selectedWordId} focusedInstanceKey={focusedInstanceKey} tpb={tpb} />)}
        </>}
        {mode === 'annotation' && !loading && !error && annotationTracks.length > 0 && <>
          {annotationSourceTracks.map((track) => {
            const annotation = annotationTracks.find((item) => item.trackId === track.id);
            const match = searchTemplate && matchLocation?.trackId === track.id ? matchLocation : null;
            const level = match && !annotation?.layers[annotationLevel] ? 0 : annotationLevel;
            return annotation?.layers[level] && <AnnotationPianoRoll key={track.id} track={track} annotation={annotation} level={level} match={match}
              categories={annotationCategories} selection={annotationSelection} location={annotationLocation?.trackId === track.id ? annotationLocation : null} onSelectNodes={selectAnnotationNodes}
              onSelectNotes={(trackId, ids, toggle, audition) => selectAnnotationNodes(trackId, 0, ids, toggle, 'roll', audition)}
              onAggregate={confirmAnnotation} canAggregate={canAggregate} onMessage={setAnnotationMessage}
              onDelete={deletionTargets.length && deletionTrack.trackId === track.id ? deleteSelectedAnnotations : undefined}
              onPlay={playAnnotationWord} playing={playing} selectedWordId={selectedWordId} tpb={annotationTpb} />;
          })}
          <div className="analysis-grid">
            <AnnotationDictionary level={dictionaryLevel} categories={annotationCategories} entries={annotationView.entries} sequences={annotationView.sequences}
              trackNames={trackNames} selectedCategory={annotationCategory} onSelectCategory={setAnnotationCategory} selection={annotationSelection}
              onConfirm={confirmAnnotation} canConfirm={canAggregate} onUndo={undoLastAnnotation} canUndo={Boolean(lastAnnotation)}
              message={annotationMessage} onPlay={playAnnotationWord} playing={playing} onSearch={openSimilaritySearch}
              editing={editingAnnotation} onCancelEdit={() => { setEditingAnnotation(null); clearAnnotationSelection(); }} />
            <FrequencyChart entries={annotationView.entries} onPlay={playAnnotationWord} playing={playing} selectedWordId={selectedWordId} manual />
          </div>
          {searchTemplate && <AnnotationSimilarity template={searchTemplate} sourceTracks={annotationSourceTracks} annotationTracks={annotationTracks}
            parameters={matchParameters} setParameters={setMatchParameters} scope={matchScope} setScope={setMatchScope}
            categories={annotationCategories} tpb={annotationTpb} onAccept={acceptSimilarSegments} onClose={() => setSearchTemplate(null)}
            onLocate={locateMatch} locatedId={matchLocation?.id} onPlay={playAnnotationWord} playing={playing} Preview={WordPianoRoll} />}
          <AnnotationResults key={`${midi?.sourceId}:${annotationLevel}`} level={annotationLevel} sequences={managedAnnotationView.sequences}
            categories={annotationCategories} trackNames={trackNames} onDelete={deleteManagedAnnotations} onReclassify={reclassifyAnnotations}
            onLocate={locateAnnotation} location={annotationLocation}
            onEdit={editManagedAnnotation} onSearch={openSimilaritySearch} onPlay={playAnnotationWord} playing={playing} Preview={WordPianoRoll} />
        </>}
      </div>
    </main>
  </div>;
}
