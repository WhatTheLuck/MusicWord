import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, Check, Play, Trash, X } from '@phosphor-icons/react';
import { DEFAULT_MATCH_PARAMETERS, normalizeMatchParameters } from './annotation-match';

export function AnnotationSimilarity({ template, sourceTracks, annotationTracks, categories, tpb, onAccept, onClose, onLocate, locatedId, onPlay, playing, Preview, parameters, setParameters, scope, setScope }) {
  const [result, setResult] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const panel = useRef(null);
  const form = useRef(null);
  const category = categories.find((item) => item.id === template.categoryId);
  const color = category?.color;
  useEffect(() => {
    setResult(null);
    setChecked(new Set());
    setError('');
    if (!form.current.checkValidity()) {
      setBusy(false);
      setError('请检查查找参数的取值。');
      return;
    }
    setBusy(true);
    let job;
    let active = true;
    const finish = () => {
      active = false;
      job?.terminate();
      setBusy(false);
    };
    const timer = setTimeout(() => {
      try {
        job = new Worker(new URL('./annotation-match.worker.js', import.meta.url), { type: 'module' });
        job.onmessage = ({ data }) => {
          if (!active) return;
          finish();
          if (data.error) { setError(data.error); return; }
          setResult(data);
          setChecked(new Set(data.candidates.map((item) => item.id)));
        };
        job.onerror = () => {
          if (!active) return;
          finish();
          setError('查找失败，请调整参数或缩小查找范围。');
        };
        job.postMessage({ template, annotationTracks, level: template.level, parameters: normalizeMatchParameters(parameters), tpb,
          sourceTracks: scope === 'track' ? sourceTracks.filter((track) => track.id === template.trackId) : sourceTracks,
        });
      } catch (err) {
        finish();
        setError(err.message || '无法开始查找');
      }
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
      job?.terminate();
    };
  }, [template, sourceTracks, annotationTracks, parameters, scope, tpb]);
  useEffect(() => { panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [template]);
  const change = (key, value) => setParameters((old) => ({ ...old, [key]: value }));
  const numeric = (key, label, min, max, step, suffix) => <label className="assist-field">
    <span>{label}{suffix && <small>{suffix}</small>}</span>
    <input type="number" min={min} max={max} step={step} value={parameters[key]} required
      onChange={(event) => change(key, event.target.value === '' ? '' : Number(event.target.value))} />
  </label>;
  return <section className="panel annotation-assist" ref={panel} aria-labelledby="annotation-assist-title" style={{ '--word-color': color }}>
    <div className="panel-heading assist-heading">
      <div><h2 id="annotation-assist-title">查找相似片段 · {category?.label ?? template.categoryId}</h2><span className="meta">L{template.level}</span></div>
      <button className="secondary-button" onClick={onClose}><X size={14} />关闭查找</button>
    </div>
    <form className="assist-form" ref={form} onSubmit={(event) => event.preventDefault()}>
      <div className="assist-parameters">
        {numeric('threshold', '最低相似度', 1, 100, 1, '%')}
        {numeric('onsetTolerance', '起音容差', 0, 2, 0.025, '拍')}
        {numeric('durationTolerance', '时长容差', 0, 200, 1, '%')}
        {numeric('transpose', '允许移调 ±', 0, 24, 1, '半音')}
        {numeric('tempoTolerance', '时长缩放 ±', 0, 50, 1, '%')}
        {numeric('maxResults', '最多预览', 1, 500, 1, '个')}
        <label className="assist-field"><span>查找范围</span><select value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="track">模板所在音轨</option><option value="visible">当前勾选音轨</option>
        </select></label>
      </div>
      <div className="assist-toolbar">
        <label className="assist-check"><input type="checkbox" checked={parameters.skipAnnotated} onChange={(event) => change('skipAnnotated', event.target.checked)} />跳过当前层已标注音符</label>
        <span>0 表示严格匹配；相似度同时考虑缺失、多余音符和时间偏差。</span>
        <button type="button" className="secondary-button" onClick={() => setParameters(DEFAULT_MATCH_PARAMETERS)}><ArrowCounterClockwise size={14} />重置参数</button>
      </div>
    </form>
    <div className="assist-status" role="status" aria-live="polite">
      {busy ? '正在查找相似片段…' : error || (result ? result.candidates.length
        ? `找到 ${result.total} 个片段${result.total > result.candidates.length ? `，按时间显示相似度最高的 ${result.candidates.length} 个` : ''}。试听并勾选要接受的结果。`
        : '未找到符合条件的片段。可降低最低相似度、增加容差或扩大查找范围。' : '')}
    </div>
    {Boolean(result?.candidates.length) && <>
      <div className="assist-toolbar assist-result-actions">
        <label className="assist-check"><input type="checkbox" aria-label="全选候选片段" checked={checked.size === result.candidates.length}
          onChange={(event) => setChecked(new Set(event.target.checked ? result.candidates.map((item) => item.id) : []))} />全选候选</label>
        <span>已选 {checked.size} / {result.candidates.length}</span>
        <button className="primary-button" disabled={!checked.size} onClick={() => {
          const message = onAccept(result.candidates.filter((item) => checked.has(item.id)), template, normalizeMatchParameters(parameters));
          if (message) setError(message);
        }}>
          <Check size={15} />接受 {checked.size} 个，标为 {template.categoryId}
        </button>
      </div>
      <div className="assist-candidates">
        {result.candidates.map((candidate, index) => {
          const key = `match:${candidate.id}`;
          const located = candidate.id === locatedId;
          const locate = () => onLocate(candidate, color);
          return <div className={`assist-candidate${located ? ' located' : ''}`} key={candidate.id} onClick={(event) => {
            if (!event.target.closest('button, label')) locate();
          }}>
            <label className="assist-check"><input type="checkbox" aria-label={`接受候选 ${index + 1}`} checked={checked.has(candidate.id)} onChange={(event) => setChecked((old) => {
              const next = new Set(old); if (event.target.checked) next.add(candidate.id); else next.delete(candidate.id); return next;
            })} /><b>#{index + 1}</b></label>
            <button className="assist-preview" onClick={() => { onPlay(candidate, key); locate(); }} aria-label={`试听候选 ${index + 1}`}>
              <Play size={14} weight="fill" /><Preview word={candidate} active={playing?.key === key} progress={playing?.progress} />
            </button>
            <button type="button" className="assist-candidate-location" onClick={locate} aria-current={located || undefined} aria-label={`在钢琴卷帘定位候选 ${index + 1}`}>
              {sourceTracks.find((track) => track.id === candidate.trackId)?.name}<small>第 {(candidate.start / tpb + 1).toFixed(2)}–{(candidate.end / tpb + 1).toFixed(2)} 拍 · {candidate.notes.length} 音符</small>
            </button>
            <span className="assist-score">{(candidate.score * 100).toFixed(1)}%<small>移调 {candidate.shift > 0 ? '+' : ''}{candidate.shift} · 时长 ×{candidate.scale.toFixed(2)}</small></span>
          </div>;
        })}
      </div>
    </>}
  </section>;
}

export function AnnotationResults({ level, sequences, categories, trackNames, onDelete, onReclassify, onLocate, location, onEdit, onSearch, onPlay, playing, Preview }) {
  const [filter, setFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [checked, setChecked] = useState(new Set());
  const [targetCategory, setTargetCategory] = useState(categories[0]?.id ?? 'A');
  const rows = useMemo(() => sequences.flatMap((sequence) => sequence.words.filter((word) => !word.automatic)
    .map((word) => ({ word, trackId: sequence.trackId, segmentId: word.instanceId, key: JSON.stringify([sequence.trackId, word.instanceId]) }))), [sequences]);
  const visible = rows.filter(({ word }) => (filter === 'all' || (filter === 'assisted' ? Boolean(word.assistance) : !word.assistance))
    && (categoryFilter === 'all' || word.id === categoryFilter));
  const selected = visible.filter((row) => checked.has(row.key));
  const setFilterValue = (setter, value) => { setter(value); setChecked(new Set()); };
  return <section className="panel annotation-results" aria-labelledby="annotation-results-title">
    <div className="panel-heading assist-heading"><div><h2 id="annotation-results-title">L{level} 标注结果</h2><span className="meta">{rows.length} 个片段 · 修改和删除均可撤销</span></div></div>
    <div className="assist-toolbar">
      <label className="assist-field"><span>来源</span><select value={filter} onChange={(event) => setFilterValue(setFilter, event.target.value)}><option value="all">全部标注</option><option value="assisted">辅助标注</option><option value="manual">手工标注</option></select></label>
      <label className="assist-field"><span>词类</span><select value={categoryFilter} onChange={(event) => setFilterValue(setCategoryFilter, event.target.value)}><option value="all">全部词类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
      <label className="assist-check"><input type="checkbox" checked={Boolean(visible.length) && selected.length === visible.length} onChange={(event) => setChecked(new Set(event.target.checked ? visible.map((row) => row.key) : []))} />全选筛选结果</label>
      <span>已选 {selected.length} 个</span>
      <label className="assist-field"><span>改为词类</span><select value={targetCategory} onChange={(event) => setTargetCategory(event.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
      <button className="secondary-button" disabled={!selected.length} onClick={() => onReclassify(selected, targetCategory)}>修改所选词类</button>
      <button className="secondary-button" disabled={!selected.length} onClick={() => { onDelete(selected); setChecked(new Set()); }}><Trash size={14} />删除所选</button>
    </div>
    <div className="annotation-result-list">
      {!visible.length && <p className="assist-status">{rows.length ? '当前筛选下没有标注。' : '确认标注后，可在这里试听、修改范围、调整词类或删除。'}</p>}
      {visible.map((row) => {
        const { word, trackId, segmentId, key } = row;
        const located = location?.trackId === trackId && location.level === level && location.segmentId === segmentId;
        const playbackKey = `result:${key}`;
        return <div key={key} className="annotation-result-row" style={{ '--word-color': word.color }}>
          <label className="assist-check"><input type="checkbox" aria-label={`选择标注 ${trackNames[trackId]} ${word.id} ${rows.indexOf(row) + 1}`} checked={checked.has(key)} onChange={(event) => setChecked((old) => {
            const next = new Set(old); if (event.target.checked) next.add(key); else next.delete(key); return next;
          })} /><b>{word.id}</b></label>
          <button className="assist-preview" aria-label={`试听标注 ${rows.indexOf(row) + 1}`} onClick={() => onPlay(word, playbackKey)}><Play size={14} weight="fill" /><Preview word={word} active={playing?.key === playbackKey} progress={playing?.progress} /></button>
          <span>{trackNames[trackId]} · {word.notes.length} 音符<small>{word.assistance ? `辅助标注${word.assistance.edited ? ' · 已修改 · 原匹配' : ' · 匹配'} ${(word.assistance.score * 100).toFixed(1)}%` : '手工标注'}</small></span>
          <div className="assist-row-actions">
            <button className="secondary-button" aria-current={located || undefined} onClick={() => onLocate({ trackId, segmentId, level, categoryId: word.id })}>定位</button>
            <button className="secondary-button" onClick={() => onSearch(word, trackId)}>查找相似</button>
            <button className="secondary-button" onClick={() => onEdit(row)}>编辑范围</button>
            <button className="secondary-button" aria-label={`删除标注 ${rows.indexOf(row) + 1}`} onClick={() => onDelete([row])}><Trash size={14} />删除</button>
          </div>
        </div>;
      })}
    </div>
  </section>;
}
