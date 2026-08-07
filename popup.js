/**
 * popup.js — camada de interface.
 *
 * Não executa trabalho pesado: dispara o pipeline no service worker e reflete o progresso.
 * Em sucesso: oferece "Abrir Painel". Em falha de upload: oferece "Baixar ZIP Manualmente" (Plano B).
 */

'use strict';

/** URL do painel — vem de config.js (única fonte de verdade). */
const PANEL_URL = (self.WCLONER_CONFIG && self.WCLONER_CONFIG.PANEL_URL) || 'http://localhost:3000/';

const ui = {
  target: document.getElementById('target'),
  targetIcon: document.getElementById('targetIcon'),
  targetHost: document.getElementById('targetHost'),
  targetTitle: document.getElementById('targetTitle'),
  blockedAlert: document.getElementById('blockedAlert'),
  blockedReason: document.getElementById('blockedReason'),
  cloneButton: document.getElementById('cloneButton'),
  cloneLabel: document.querySelector('.cta__label'),
  progressPanel: document.getElementById('progressPanel'),
  progressFill: document.getElementById('progressFill'),
  progressMessage: document.getElementById('progressMessage'),
  steps: Array.from(document.querySelectorAll('.step')),
  successPanel: document.getElementById('successPanel'),
  successTitle: document.getElementById('successTitle'),
  resultFile: document.getElementById('resultFile'),
  resultStats: document.getElementById('resultStats'),
  openPanelButton: document.getElementById('openPanelButton'),
  errorPanel: document.getElementById('errorPanel'),
  errorTitle: document.getElementById('errorTitle'),
  errorMessage: document.getElementById('errorMessage'),
  fallbackDownloadButton: document.getElementById('fallbackDownloadButton'),
  fallbackHint: document.getElementById('fallbackHint'),
  resetButton: document.getElementById('resetButton')
};

/**
 * REGRA DE NEGÓCIO — páginas protegidas.
 * O Chrome recusa chrome.scripting.executeScript em páginas internas e nas lojas.
 */
const BLOCKED_RULES = [
  { re: /^chrome:\/\//i, reason: 'Páginas internas do Chrome (chrome://) não permitem injeção de scripts.' },
  { re: /^chrome-untrusted:\/\//i, reason: 'Esta é uma página interna protegida do navegador.' },
  { re: /^(edge|brave|opera|vivaldi):\/\//i, reason: 'Páginas internas do navegador não permitem injeção de scripts.' },
  { re: /^about:/i, reason: 'Páginas "about:" são internas do navegador e não podem ser clonadas.' },
  { re: /^devtools:\/\//i, reason: 'O DevTools não pode ser clonado.' },
  { re: /^view-source:/i, reason: 'A visualização de código-fonte não pode ser clonada.' },
  { re: /^(chrome|moz)-extension:\/\//i, reason: 'Páginas de outras extensões são protegidas pelo navegador.' },
  { re: /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i, reason: 'A Chrome Web Store bloqueia extensões por política do próprio Chrome.' },
  { re: /^https?:\/\/microsoftedge\.microsoft\.com\/addons/i, reason: 'A loja de complementos do Edge bloqueia extensões.' },
  { re: /^https?:\/\/addons\.mozilla\.org/i, reason: 'A loja de complementos do Firefox bloqueia extensões.' }
];

const STEP_ORDER = ['crawl', 'dom', 'css', 'assets', 'zip', 'upload'];
const STEP_ALIASES = {
  inject: 'dom',
  rewrite: 'zip',
  download: 'upload',
  done: 'upload',
  error: null
};

let activeTab = null;
let blocked = false;
let fallbackBusy = false;

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function show(element, visible) {
  if (!element) return;
  element.hidden = !visible;
}

function renderTarget(tab) {
  let host = tab?.url || 'Aba desconhecida';
  try {
    const parsed = new URL(tab.url);
    host = /^https?:$/.test(parsed.protocol) ? parsed.hostname || tab.url : tab.url;
  } catch { /* mantém o texto bruto */ }

  ui.targetHost.textContent = host;
  ui.targetTitle.textContent = tab?.title || '';
  if (tab?.favIconUrl && /^https?:/i.test(tab.favIconUrl)) {
    ui.targetIcon.hidden = false;
    ui.targetIcon.src = tab.favIconUrl;
  } else {
    ui.targetIcon.hidden = true;
  }
}

function renderSteps(step) {
  const normalized = step in STEP_ALIASES ? STEP_ALIASES[step] : step;
  const activeIndex = STEP_ORDER.indexOf(normalized);

  ui.steps.forEach((li, index) => {
    li.classList.toggle('is-done', activeIndex > index);
    li.classList.toggle('is-active', activeIndex === index);
  });
}

function renderSummary(summary) {
  if (!summary) return;
  ui.resultFile.textContent = summary.fileName || '';
  ui.resultStats.innerHTML = '';

  const rows = [
    ['Páginas clonadas', summary.pages],
    ['Assets baixados', summary.assetsOk],
    ['Mantidos remotos', summary.assetsFailed],
    ['Folhas de estilo', summary.stylesheets],
    ['Shadow roots', summary.shadowRoots],
    ['Canvas convertidos', summary.canvases],
    ['Tamanho dos assets', `${summary.sizeMb} MB`]
  ];

  for (const [label, value] of rows) {
    if (value === undefined || value === null) continue;
    const li = document.createElement('li');
    li.innerHTML = `${label}: <b></b>`;
    li.querySelector('b').textContent = String(value);
    ui.resultStats.appendChild(li);
  }

  const panelUrl = summary.panelUrl || PANEL_URL;
  ui.openPanelButton.href = panelUrl;
}

function render(state) {
  const isRunning = state.state === 'running';
  const canFallback = Boolean(state.canFallbackDownload);

  ui.cloneButton.classList.toggle('is-busy', isRunning);
  ui.cloneButton.disabled = isRunning || blocked;
  ui.cloneLabel.textContent = isRunning ? 'Clonando…' : 'Clonar Página Atual';

  show(ui.progressPanel, isRunning);
  show(ui.successPanel, state.state === 'done');
  show(ui.errorPanel, state.state === 'error');
  show(ui.resetButton, state.state === 'done' || state.state === 'error');

  ui.progressFill.style.width = `${state.percent || 0}%`;
  ui.progressMessage.textContent = state.message || '';
  renderSteps(state.step);

  if (state.state === 'done') {
    ui.successTitle.textContent = state.message || 'Sucesso! Site salvo no seu Painel.';
    renderSummary(state.summary);
  }

  if (state.state === 'error') {
    ui.errorTitle.textContent = canFallback
      ? 'Falha ao enviar para o painel'
      : 'Não foi possível clonar';
    ui.errorMessage.textContent = state.message || 'Erro desconhecido.';
    show(ui.fallbackDownloadButton, canFallback);
    show(ui.fallbackHint, canFallback);
    ui.fallbackDownloadButton.disabled = fallbackBusy;
    ui.fallbackDownloadButton.classList.toggle('is-busy', fallbackBusy);
  } else {
    show(ui.fallbackDownloadButton, false);
    show(ui.fallbackHint, false);
  }
}

// ---------------------------------------------------------------------------
// Inicialização + eventos
// ---------------------------------------------------------------------------

async function init() {
  // Garante o href do botão "Abrir Painel" mesmo antes de um clone bem-sucedido.
  if (ui.openPanelButton) ui.openPanelButton.href = PANEL_URL;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  renderTarget(tab);

  const url = tab?.url || '';
  const rule = BLOCKED_RULES.find((item) => item.re.test(url));

  if (!url || rule) {
    blocked = true;
    ui.blockedReason.textContent = rule
      ? `${rule.reason} Abra um site comum (http ou https) para usar o clonador.`
      : 'Não foi possível identificar o endereço desta aba.';
    show(ui.blockedAlert, true);
    ui.cloneButton.disabled = true;
    return;
  }

  if (/^file:\/\//i.test(url)) {
    ui.blockedReason.textContent =
      'Para clonar arquivos locais, habilite "Permitir acesso a URLs de arquivo" nos detalhes da extensão. Assets externos podem falhar.';
    show(ui.blockedAlert, true);
  }

  const state = await chrome.runtime.sendMessage({ type: 'WEB_CLONER_GET_STATE' }).catch(() => null);
  if (state) render(state);
}

ui.cloneButton.addEventListener('click', async () => {
  if (blocked || !activeTab) return;

  render({
    state: 'running',
    percent: 3,
    step: 'dom',
    message: 'Preparando a captura…',
    canFallbackDownload: false
  });

  const response = await chrome.runtime
    .sendMessage({ type: 'WEB_CLONER_START', tabId: activeTab.id })
    .catch((error) => ({ ok: false, error: error?.message }));

  if (!response?.ok) {
    render({
      state: 'error',
      percent: 0,
      step: 'error',
      message: response?.error || 'Falha ao iniciar a clonagem.',
      canFallbackDownload: false
    });
  }
});

ui.fallbackDownloadButton.addEventListener('click', async () => {
  if (fallbackBusy) return;
  fallbackBusy = true;
  ui.fallbackDownloadButton.classList.add('is-busy');
  ui.fallbackDownloadButton.disabled = true;
  ui.fallbackDownloadButton.querySelector('.btn__label').textContent = 'Baixando…';

  const response = await chrome.runtime
    .sendMessage({ type: 'WEB_CLONER_FALLBACK_DOWNLOAD' })
    .catch((error) => ({ ok: false, error: error?.message }));

  fallbackBusy = false;
  ui.fallbackDownloadButton.classList.remove('is-busy');
  ui.fallbackDownloadButton.disabled = false;
  ui.fallbackDownloadButton.querySelector('.btn__label').textContent = 'Baixar ZIP Manualmente';

  if (response?.ok) {
    ui.errorTitle.textContent = 'ZIP salvo localmente';
    ui.errorMessage.textContent = `Download de emergência concluído: ${response.fileName}`;
  } else {
    ui.errorMessage.textContent =
      response?.error || 'Não foi possível baixar o ZIP. Tente clonar novamente.';
  }
});

ui.resetButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'WEB_CLONER_RESET' }).catch(() => {});
  fallbackBusy = false;
  render({ state: 'idle', percent: 0, step: '', message: '', canFallbackDownload: false });
  show(ui.progressPanel, false);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'WEB_CLONER_PROGRESS') return undefined;
  render(message);
  return undefined;
});

init();
