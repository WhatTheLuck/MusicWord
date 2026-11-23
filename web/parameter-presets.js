const host = document.getElementById('parameter-presets');
const feedback = document.getElementById('parameter-status');
const template = document.getElementById('parameter-preset-template');
const pagePanels = {annotation: 'bpe-panel', 'bpe-run': 'bpe-panel', ssm: 'ssm-panel', activebasis: 'activebasis-panel', lego: 'lego-panel'};
const pageLabels = {annotation: '标注', 'bpe-run': 'BPE', ssm: 'SSM', activebasis: 'ActiveBasis', lego: 'LEGO', all: '全部页面'};
const states = new Map();
const views = new Map();
let active;
let locked = false;
let feedbackTimer;

function stateFor(page) {
  if (!states.has(page)) states.set(page, {presets: [], selected: '', fetching: false, loaded: false, request: 0});
  return states.get(page);
}

function targetFor(scope) {
  return scope === 'all' ? {page: 'all', label: '全部页面'} : {...active};
}

function message(text, error = false) {
  clearTimeout(feedbackTimer);
  feedback.textContent = text;
  feedback.classList.toggle('error', error);
  feedback.hidden = !text;
  if (text) feedbackTimer = setTimeout(() => { feedback.hidden = true; }, error ? 12000 : 6500);
}

async function api(page, options) {
  const response = await fetch('/api/parameter-presets/' + page, options);
  const data = await response.json().catch(() => { throw new Error('无法读取预设，请重启工作台后重试。'); });
  if (!response.ok) throw new Error(data.error || '无法读写参数预设。');
  return data;
}

function adapter(target) {
  const result = target.frame.contentWindow?.MusicWordParameters;
  if (!result || result.ready === false) throw new Error(target.label + '页面正在准备参数，请稍后重试。');
  return result;
}

function render() {
  if (!active) return;
  host.setAttribute('aria-busy', String(locked));
  for (const [scope, view] of views) {
    const target = targetFor(scope);
    const state = stateFor(target.page);
    const placeholder = state.fetching ? '正在读取预设…'
      : scope === 'page' ? active.label + ' · 选择预设' : '选择全部页面预设';
    view.select.replaceChildren(new Option(placeholder, ''), ...state.presets.map(preset => {
      const option = new Option(preset.name, preset.id);
      option.title = preset.name + ' · ' + new Date(preset.savedAt).toLocaleString('zh-CN', {hour12: false});
      return option;
    }));
    view.select.value = state.selected;
    view.select.title = state.presets.find(preset => preset.id === state.selected)?.name || placeholder;
    view.select.disabled = locked || state.fetching || !state.presets.length;
    view.importButton.disabled = view.saveButton.disabled = locked;
    view.confirm.disabled = view.name.disabled = locked;
    view.confirm.textContent = locked ? '保存中…' : '保存预设';
  }
}

async function refresh(page) {
  const state = stateFor(page);
  const request = ++state.request;
  state.fetching = true;
  render();
  try {
    const presets = await api(page);
    if (state.request !== request) return;
    state.presets = presets;
    state.loaded = true;
    if (!presets.some(preset => preset.id === state.selected)) state.selected = '';
  } catch (error) {
    if (state.request === request) message(error.message, true);
  } finally {
    if (state.request === request) state.fetching = false;
    render();
  }
}

async function run(action) {
  if (locked) return;
  locked = true;
  render();
  try { await action(); }
  catch (error) { message(error.message || '操作失败，请重试。', true); }
  finally {
    locked = false;
    render();
    if (!stateFor(active.page).loaded && !stateFor(active.page).fetching) void refresh(active.page);
  }
}

async function allAdapters() {
  const entries = Object.entries(pagePanels).map(([page, panel]) => {
    const frame = document.querySelector('#' + panel + ' iframe');
    if (!frame.hasAttribute('src')) frame.src = new URL(frame.dataset.src, location.href).href;
    return {page, label: pageLabels[page], frame};
  });
  await Promise.all(entries.map(async entry => {
    const deadline = Date.now() + 60000;
    while (!entry.frame.contentWindow?.MusicWordParameters || entry.frame.contentWindow.MusicWordParameters.ready === false) {
      if (Date.now() > deadline) throw new Error(entry.label + '页面初始化超时，请打开该页检查后重试。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }));
  return entries.map(entry => ({...entry, api: adapter(entry)}));
}

const audioFields = () => [...document.querySelectorAll('#workspace-audio select, #workspace-audio input')];
const audioKeys = ['instrument', 'bpm', 'volume'];

function validateAudio(settings) {
  const fields = audioFields();
  for (const [index, key] of audioKeys.entries()) {
    const field = fields[index]?.cloneNode(true);
    if (!field || settings?.[key] === undefined) throw new Error('配置文件缺少有效的试听设置。');
    field.value = settings[key];
    if (!field.value || !field.checkValidity()) throw new Error('试听设置无效：' + key);
  }
}

async function snapshot(target) {
  if (target.page !== 'all') return adapter(target).snapshot(target.page);
  message('正在收集五个页面的参数…');
  const entries = await allAdapters();
  const pages = Object.fromEntries(await Promise.all(entries.map(async ({page, api}) => [page, await api.snapshot(page)])));
  const audio = Object.fromEntries(audioFields().map((field, index) => [audioKeys[index], field.value]));
  validateAudio(audio);
  return {pages, audio};
}

async function prepare(preset, target) {
  if (preset?.schemaVersion !== 1 || preset.page !== target.page || !preset.settings || typeof preset.settings !== 'object') {
    if (preset?.page === 'all' && target.page !== 'all') throw new Error('这是全部页面配置，请使用「全部页面」旁的文件按钮加载。');
    if (pageLabels[preset?.page] && preset.page !== target.page) throw new Error('这是' + pageLabels[preset.page] + '配置，请在对应的预设栏加载。');
    throw new Error('配置文件格式无效，请选择保存预设时生成的 JSON 文件。');
  }
  const settings = structuredClone(preset.settings);
  if (target.page !== 'all') {
    const api = adapter(target);
    await api.validate(settings, target.page);
    return async () => {
      await api.apply(settings, target.page);
      stateFor('all').selected = '';
    };
  }
  const entries = await allAdapters();
  validateAudio(settings.audio);
  // Check every page before changing any page.
  for (const {page, api} of entries) await api.validate(settings.pages?.[page], page);
  return async () => {
    for (const {page, api} of entries) await api.apply(settings.pages[page], page);
    for (const {page} of entries) stateFor(page).selected = '';
    audioFields().forEach((field, index) => {
      field.value = settings.audio[audioKeys[index]];
      field.dispatchEvent(new Event(index === 0 ? 'change' : 'input', {bubbles: true}));
    });
  };
}

async function persist(target, name, settings) {
  const preset = await api(target.page, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name, settings})});
  const state = stateFor(target.page);
  // Invalidate an older list request so it cannot remove this newly saved preset.
  state.request++;
  state.fetching = false;
  state.loaded = true;
  state.presets = [preset, ...state.presets.filter(item => item.id !== preset.id)];
  state.selected = preset.id;
  return preset;
}

function download(preset) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2) + '\n'], {type: 'application/json'}));
  const link = document.createElement('a');
  const safeName = preset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60);
  link.href = url;
  link.download = 'MusicWord-' + pageLabels[preset.page] + '-' + safeName + '-' + preset.savedAt.replace(/[:.]/g, '-') + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function positionPopover(view) {
  const rect = view.saveButton.getBoundingClientRect();
  view.popover.style.left = Math.max(8, Math.min(rect.right - view.popover.offsetWidth, innerWidth - view.popover.offsetWidth - 8)) + 'px';
  view.popover.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - view.popover.offsetHeight - 8)) + 'px';
}

for (const scope of ['page', 'all']) {
  const group = template.content.firstElementChild.cloneNode(true);
  const label = scope === 'page' ? '本页' : '全部页面';
  group.dataset.presetScope = scope;
  group.setAttribute('aria-label', label + '参数');
  const view = {
    group, select: group.querySelector('.preset-select'), importButton: group.querySelector('.preset-import'),
    file: group.querySelector('.preset-file'), saveButton: group.querySelector('.preset-save'),
    popover: group.querySelector('.preset-save-popover'), form: group.querySelector('form'),
    name: group.querySelector('.preset-name'), confirm: group.querySelector('.preset-confirm'),
  };
  view.select.id = scope + '-parameter-preset';
  view.select.setAttribute('aria-label', label + '参数预设');
  group.querySelector('.preset-scope-label').htmlFor = view.select.id;
  group.querySelector('.preset-scope-label').textContent = label;
  view.importButton.setAttribute('aria-label', '加载' + label + '配置文件');
  view.importButton.title = '加载' + label + '配置文件（JSON）';
  view.file.setAttribute('aria-label', label + '配置文件');
  view.saveButton.setAttribute('aria-label', '保存' + label + '参数');
  view.saveButton.title = '保存' + label + '参数预设';
  view.popover.id = scope + '-preset-save-popover';
  view.saveButton.setAttribute('aria-controls', view.popover.id);
  view.saveButton.setAttribute('aria-expanded', 'false');
  view.name.id = scope + '-preset-name';
  group.querySelector('.preset-name-label').htmlFor = view.name.id;
  view.name.setAttribute('aria-label', label + '预设名称');
  views.set(scope, view);
  host.append(group);

  view.saveButton.addEventListener('click', () => {
    if (locked) return;
    if (view.popover.matches(':popover-open')) { view.popover.hidePopover(); return; }
    view.target = targetFor(scope);
    group.querySelector('.preset-save-heading').textContent = '保存' + view.target.label + '参数预设';
    view.name.value = '';
    view.popover.showPopover();
    positionPopover(view);
    view.name.focus({preventScroll: true});
  });
  view.popover.addEventListener('toggle', event => view.saveButton.setAttribute('aria-expanded', String(event.newState === 'open')));
  group.querySelector('.preset-cancel').addEventListener('click', () => {
    view.popover.hidePopover();
    view.saveButton.focus({preventScroll: true});
  });
  view.form.addEventListener('submit', event => {
    event.preventDefault();
    const target = view.target;
    const name = view.name.value.trim() || target.label + '参数 ' + new Date().toLocaleString('zh-CN', {hour12: false});
    void run(async () => {
      const settings = await snapshot(target);
      const preset = await persist(target, name, settings);
      download(preset);
      view.popover.hidePopover();
      message('已保存「' + preset.name + '」，配置文件已下载。');
    });
  });
  view.select.addEventListener('change', () => {
    const target = targetFor(scope);
    const state = stateFor(target.page);
    const preset = state.presets.find(item => item.id === view.select.value);
    if (!preset) { state.selected = ''; render(); return; }
    void run(async () => {
      const apply = await prepare(preset, target);
      await apply();
      state.selected = preset.id;
      message('已加载「' + preset.name + '」至' + target.label + '。');
    });
  });
  view.importButton.addEventListener('click', () => {
    view.importTarget = targetFor(scope);
    view.file.click();
  });
  view.file.addEventListener('change', () => {
    const file = view.file.files[0];
    view.file.value = '';
    if (!file) return;
    const target = view.importTarget;
    void run(async () => {
      if (file.size > 1024 * 1024) throw new Error('配置文件过大，无法加载。');
      let document;
      try { document = JSON.parse(await file.text()); }
      catch { throw new Error('无法读取 JSON，请选择保存预设时生成的配置文件。'); }
      message('正在加载' + target.label + '配置文件…');
      const apply = await prepare(document, target);
      const name = (typeof document.name === 'string' && document.name.trim() || file.name.replace(/\.json$/i, '')).slice(0, 80);
      const preset = await persist(target, name, document.settings);
      await apply();
      stateFor(target.page).selected = preset.id;
      message('已加载「' + preset.name + '」，并加入' + (scope === 'page' ? '本页' : '全部页面') + '预设列表。');
    });
  });
}

export function activateParameterPresets(page, label, frame) {
  for (const view of views.values()) if (view.popover.matches(':popover-open')) view.popover.hidePopover();
  active = {page, label, frame};
  render();
  if (!locked) {
    void refresh(page);
    void refresh('all');
  }
}

window.addEventListener('resize', () => {
  for (const view of views.values()) if (view.popover.matches(':popover-open')) positionPopover(view);
});
