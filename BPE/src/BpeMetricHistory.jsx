import { useEffect, useMemo, useState } from 'react';
import { isBpeRootAt } from './bpe';

const colors = ['#b3a0ff', '#ffd18a', '#66e2c6', '#fa9dc7', '#8abfff', '#d2e68c', '#ff9b81', '#edf0ff'];
const decimals = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

function roundsToCompare(history, hierarchies, scope) {
  if (scope === 'top') return history.map(({ round }) => ({ round, origin: round }));
  // For a fixed level, only rounds creating new instances change the comparison.
  const level = Number(scope);
  const roundsWithNewNodes = new Set();
  for (const { nodes } of hierarchies.values()) {
    for (const node of nodes) if (node.level === level) roundsWithNewNodes.add(node.round);
  }
  let origin;
  return history.flatMap(({ round }) => {
    if (roundsWithNewNodes.has(round)) origin = round;
    return origin === undefined ? [] : [{ round, origin }];
  });
}

function comparisonAt(origin, scope, hierarchies, tracks, reference, shared) {
  const totals = { matches: 0, manual: 0, predicted: 0, covered: 0 };
  const comparisons = [];
  for (const track of tracks) {
    const manual = reference.get(track.id)?.manual;
    if (!manual?.length) continue;
    const predictions = hierarchies.get(track.id).nodes.filter((node) => scope === 'top'
      ? isBpeRootAt(node, origin) : node.round <= origin && node.level === Number(scope))
      .map(({ word }) => ({
        categoryId: word.id,
        noteIds: word.notes.map(({ id }) => id),
        box: shared.noteBox(word.notes.map(({ onset, duration, pitch }) => ({ start: onset, end: onset + duration, pitch }))),
      }));
    const counts = shared.fragmentCounts(manual.map(({ noteIds }) => noteIds), predictions.map(({ noteIds }) => noteIds));
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    comparisons.push(shared.comparisonTrack(track.events, manual, predictions));
  }
  return { totals, comparisons };
}

export default function BpeMetricHistory({ history, hierarchies, tracks, referenceByTrack, reference, sourceMatches,
  shared, evaluation, loading, error, visibleLevels, topWordsOnly }) {
  const [chosenScope, setChosenScope] = useState(null);
  const [points, setPoints] = useState([]);
  const [selectedRound, setSelectedRound] = useState(null);
  const [message, setMessage] = useState('');
  const scores = useMemo(() => new WeakMap(), [tracks, referenceByTrack, shared]);
  const fallback = visibleLevels.length === 1 ? String(visibleLevels[0]) : 'top';
  const chosenIsVisible = chosenScope === 'top' || visibleLevels.some((level) => String(level) === chosenScope);
  const scope = topWordsOnly ? 'top' : chosenIsVisible ? chosenScope : fallback;
  const scopeLabel = scope === 'top' ? '顶层词' : `L${scope}`;

  useEffect(() => {
    setPoints([]);
    setMessage('');
    if (!reference || !shared || !evaluation) return;
    if (loading || error || !sourceMatches) {
      evaluation.setScore(loading ? '正在读取乐谱…' : error ? '乐谱读取失败，无法比对。' : '当前 MIDI 与所加载的标注不同。');
      return;
    }
    const rounds = roundsToCompare(history, hierarchies, scope);
    if (!rounds.length || !tracks.some((track) => referenceByTrack.get(track.id)?.manual.length)) {
      evaluation.setScore('当前音轨在所选层没有人工标注。');
      return;
    }
    const controller = new AbortController();
    const cached = ({ origin }) => scores.get(history[origin])?.get(scope);
    const pending = new Set(rounds.filter((point) => !cached(point)).map(({ origin }) => origin));
    const show = () => {
      setPoints(rounds.flatMap((point) => cached(point) ? [{ ...point, ...cached(point) }] : []));
      const latest = rounds.at(-1);
      const score = cached(latest);
      if (score) {
        evaluation.setScore(shared.formatScores(score.totals, `第 ${latest.round} 轮 · ${scopeLabel}`));
        evaluation.setMetrics(score.values);
      }
    };
    show();
    if (!pending.size) return;
    const status = '正在计算轮次匹配指标…';
    setMessage(status);
    evaluation.setScore(status);
    async function compute() {
      let batch = [];
      let size = 0;
      const flush = async () => {
        if (!batch.length || controller.signal.aborted) return;
        const values = await shared.annotationMetricSeries(batch.map(({ comparisons }) => comparisons), controller.signal);
        if (controller.signal.aborted) return;
        batch.forEach(({ origin, totals }, index) => {
          const state = history[origin];
          if (!scores.has(state)) scores.set(state, new Map());
          scores.get(state).set(scope, { totals, values: { ...values[index], ...shared.fragmentMetrics(totals) } });
        });
        batch = [];
        size = 0;
        show();
      };
      for (const origin of pending) {
        if (controller.signal.aborted) return;
        const result = comparisonAt(origin, scope, hierarchies, tracks, referenceByTrack, shared);
        const length = JSON.stringify(result.comparisons).length;
        if (batch.length && (batch.length === 8 || size + length > 4_000_000)) await flush();
        batch.push({ origin, ...result });
        size += length;
      }
      await flush();
      if (!controller.signal.aborted) setMessage('');
    }
    compute().catch((failure) => {
      if (!controller.signal.aborted) { setMessage(failure.message); evaluation.setScore(failure.message); }
    });
    return () => controller.abort();
  }, [history, hierarchies, tracks, referenceByTrack, reference, sourceMatches, shared, evaluation, loading, error, scope, scopeLabel, scores]);

  if (!reference || !shared) return null;
  const selected = points.find(({ round }) => round === selectedRound) ?? points.at(-1);
  const firstRound = points[0]?.round ?? 0;
  const lastRound = points.at(-1)?.round ?? 0;
  const lower = Math.min(0, ...points.map(({ values }) => Math.floor(values.ARI * 4) / 4));
  const x = (round) => 35 + (round - firstRound) * 746 / Math.max(1, lastRound - firstRound);
  const y = (value) => 130 - (value - lower) * 116 / (1 - lower);
  const grid = lower < 0 ? [lower, 0, .5, 1] : [0, .5, 1];
  return <section className="panel bpe-metric-history" aria-labelledby="bpe-metric-heading">
    <div className="panel-heading assist-heading">
      <h2 id="bpe-metric-heading">轮次匹配指标</h2>
      <label className="bpe-metric-scope">比对范围 <select value={scope} disabled={topWordsOnly} onChange={(event) => {
        setSelectedRound(null);
        setChosenScope(event.target.value);
      }}>
        <option value="top">每轮顶层（无父节点）</option>
        {visibleLevels.map((level) => <option key={level} value={level}>L{level}</option>)}
      </select></label>
    </div>
    {message && <p className="assist-status" role="status">{message}</p>}
    {selected && <div className="bpe-metric-body">
      <svg className="bpe-metric-plot" viewBox="0 0 800 154" role="img" aria-label="匹配指标随 BPE 轮次的变化">
        {grid.map((value) => <g key={value}>
          <line x1="35" x2="781" y1={y(value)} y2={y(value)} className="bpe-metric-grid" />
          <text x="28" y={y(value) + 4} textAnchor="end">{value}</text>
        </g>)}
        <line x1={x(selected.round)} x2={x(selected.round)} y1="14" y2="130" className="bpe-metric-marker" />
        {[...new Set([firstRound, lastRound])].map((round) => <text key={round} x={x(round)} y="148" textAnchor="middle">{round}</text>)}
        {shared.historyMetricNames.map(([key], series) => <g key={key} stroke={colors[series]}>
          <polyline points={points.map((point) => `${x(point.round)},${y(point.values[key])}`).join(' ')} fill="none" strokeWidth="1.6"
            strokeDasharray={series >= shared.metricNames.length ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
          <circle cx={x(selected.round)} cy={y(selected.values[key])} r="3" fill={colors[series]} />
        </g>)}
      </svg>
      <label className="bpe-metric-round">
        <output>第 {selected.round} 轮 · {scopeLabel} · 精确匹配 {selected.totals.matches}/{selected.totals.manual}</output>
        <input type="range" aria-label="查看指标轮次" min={firstRound} max={lastRound} value={selected.round} disabled={firstRound === lastRound}
          onChange={(event) => setSelectedRound(Number(event.target.value))} />
      </label>
      <ul className="bpe-metric-legend" aria-label="匹配指标与数值">
        {shared.historyMetricNames.map(([key, label], series) => <li key={key} style={{ '--metric-color': colors[series] }}>{label} {decimals.format(selected.values[key])}</li>)}
      </ul>
    </div>}
  </section>;
}
