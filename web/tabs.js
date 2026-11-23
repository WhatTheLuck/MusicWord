import { activateParameterPresets } from './parameter-presets.js';

const tablist = document.querySelector('[role="tablist"]');
const workspaceBar = tablist.closest('header');
const tabs = [...tablist.querySelectorAll('[role="tab"]')];
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
const frames = [...document.querySelectorAll('.workspace iframe')];
const appearanceKey = 'musicword.theme';
const deviceTheme = matchMedia('(prefers-color-scheme: dark)');
const compactToolbar = matchMedia('(max-width: 1800px)');
const audioControls = document.getElementById('workspace-audio');
const bpeRoundSlot = document.getElementById('bpe-round-slot');
const workspaceSources = document.querySelector('.workspace-sources');
const workspaceControls = workspaceSources.parentElement;
const panelToolbarStyle = document.getElementById('panel-toolbar-style');
let activeTab;
let palette;
let manualTheme;
try { manualTheme = localStorage.getItem(appearanceKey); } catch { /* Storage may be unavailable. */ }

function setFrameTheme(frame) {
  const doc = frame.contentDocument;
  if (!doc || doc.URL === 'about:blank') return;
  const root = doc.documentElement;
  for (const [name, value] of palette) root.style.setProperty(name, value);
  root.dataset.theme = document.documentElement.dataset.theme;
  doc.dispatchEvent(new Event('musicword:themechange'));
}

function setTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const style = getComputedStyle(root);
  palette = [...style].filter((name) => name.startsWith('--mw-'))
    .map((name) => [name, style.getPropertyValue(name).trim()]);
  document.querySelector('meta[name="theme-color"]').content = style.getPropertyValue('--mw-paper').trim();
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  }
  for (const frame of frames) setFrameTheme(frame);
}

function loadTheme() {
  const theme = manualTheme === 'light' || manualTheme === 'dark'
    ? manualTheme : (deviceTheme.matches ? 'dark' : 'light');
  setTheme(theme);
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    manualTheme = button.dataset.themeChoice;
    try { localStorage.setItem(appearanceKey, manualTheme); } catch { /* Still apply for this visit. */ }
    setTheme(manualTheme);
  });
}
deviceTheme.addEventListener('change', loadTheme);
loadTheme();

function syncAudioControls() {
  if (!compactToolbar.matches && audioControls.matches(':popover-open')) audioControls.hidePopover();
  audioControls.toggleAttribute('popover', compactToolbar.matches);
}

compactToolbar.addEventListener('change', syncAudioControls);
syncAudioControls();

for (const frame of frames) {
  frame.addEventListener('load', () => {
    setFrameTheme(frame);
    const doc = frame.contentDocument;
    if (doc && doc.URL !== 'about:blank') {
      const presetStyle = doc.createElement('style');
      presetStyle.textContent = '.parameter-file-actions, #presetBar { display: none !important; }';
      doc.head.append(presetStyle);
    }
    const panelToolbar = frame.dataset.toolbar;
    if (!panelToolbar || !doc || doc.URL === 'about:blank') return;

    doc.documentElement.dataset.workspaceToolbar = panelToolbar;
    doc.head.append(doc.importNode(panelToolbarStyle.content, true));

    if (panelToolbar === 'activebasis') {
      const stagePicker = doc.querySelector('#stage-select')?.closest('label');
      if (stagePicker) doc.querySelector('.topbar-inner')?.prepend(stagePicker);
    }
  });
}

function panelFor(tab) {
  return document.getElementById(tab.getAttribute('aria-controls'));
}

function notify(frame, type, mode) {
  frame.contentWindow?.postMessage({ type, mode }, location.origin);
}

function activate(tab) {
  if (activeTab === tab) return;
  window.MusicWordPreview?.stop();
  const previousPanel = activeTab && panelFor(activeTab);
  const panel = panelFor(tab);
  const frame = panel.querySelector('iframe');
  if (previousPanel && previousPanel !== panel) {
    notify(previousPanel.querySelector('iframe'), 'musicword:deactivate');
  }
  for (const candidate of tabs) {
    const chosen = candidate === tab;
    candidate.tabIndex = chosen ? 0 : -1;
    candidate.setAttribute('aria-selected', String(chosen));
    const candidatePanel = panelFor(candidate);
    candidatePanel.hidden = candidatePanel !== panel;
  }
  activeTab = tab;
  activateParameterPresets(tab.id, tab.textContent.trim(), frame);
  workspaceSources.querySelector(':popover-open')?.hidePopover();
  const sourceSlot = document.getElementById(panel.id.replace('-panel', '-source-slot'));
  for (const slot of workspaceSources.children) {
    slot.hidden = slot !== sourceSlot;
  }
  workspaceControls.hidden = !sourceSlot;
  bpeRoundSlot.hidden = tab.dataset.mode !== 'algorithm';
  workspaceBar.toggleAttribute('data-page-controls', frame.hasAttribute('data-toolbar'));
  panel.setAttribute('aria-labelledby', tab.id);
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  if (!frame.hasAttribute('src')) {
    const url = new URL(frame.dataset.src, location.href);
    if (tab.dataset.mode) url.hash = tab.dataset.mode;
    frame.src = url.href;
  } else {
    if (previousPanel !== panel) setFrameTheme(frame);
    if (tab.dataset.mode) notify(frame, 'musicword:bpe-mode', tab.dataset.mode);
    notify(frame, 'musicword:activate');
  }
  if (tab.dataset.mode) frame.title = tab.dataset.mode === 'annotation' ? '音乐词标注' : 'BPE 工作台';
}

function select(tab) {
  if (location.hash !== '#' + tab.id) history.pushState(null, '', '#' + tab.id);
  activate(tab);
}

function selectFromLocation() {
  const hash = location.hash === '#bpe-annotation' ? '#annotation' : location.hash;
  activate(tabs.find((tab) => '#' + tab.id === hash) ?? tabs[0]);
}

document.querySelector('#bpe-panel iframe').addEventListener('load', (event) => {
  if (activeTab?.dataset.mode) notify(event.currentTarget, 'musicword:bpe-mode', activeTab.dataset.mode);
});

tablist.addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) select(tab);
});

tablist.addEventListener('keydown', (event) => {
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const key = event.key;
  let target;
  if (key === 'Home') target = tabs[0];
  if (key === 'End') target = tabs.at(-1);
  if (key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
  if (key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
  if (!target) return;
  event.preventDefault();
  select(target);
  target.focus();
});

window.addEventListener('hashchange', selectFromLocation);
selectFromLocation();
