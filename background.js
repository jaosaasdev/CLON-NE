/**
 * background.js — Service worker (Manifest V3).
 *
 * Orquestra o pipeline de clonagem multi-página:
 *   popup  ->  crawl (abas)  ->  content.js  ->  CSS/assets  ->  JSZip
 *          ->  POST /api/save-clone (Painel Next.js)
 *          ->  fallback: chrome.downloads.download se o painel falhar
 *
 * ------------------------------------------------------------------------------------
 * POR QUE OS FETCHES DE ASSETS ACONTECEM AQUI? — "bypass" de CORS
 * ------------------------------------------------------------------------------------
 * Fetch no content script roda sob a origem da PÁGINA (CORS restrito).
 * Fetch no service worker roda sob chrome-extension://<id> + host_permissions,
 * então o Chrome concede acesso cross-origin privilegiado.
 */

'use strict';

importScripts('libs/jszip.min.js');
importScripts('config.js');

// ---------------------------------------------------------------------------
// Configuração do Painel (centralizada em config.js)
// ---------------------------------------------------------------------------

const API_URL = self.WCLONER_CONFIG.API_URL;
const PANEL_URL = self.WCLONER_CONFIG.PANEL_URL;
const CLONE_API_SECRET = self.WCLONER_CONFIG.CLONE_API_SECRET || '';

/** Timeout do upload (ZIPs grandes precisam de margem). */
const UPLOAD_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ASSET_TOKEN_RE = /__WCLONE_(?:ASSET|CSSASSET|MERGED)_\d+__/g;
const FONT_EXT = /\.(woff2?|ttf|otf|eot|sfnt)(\?|#|$)/i;
const MEDIA_EXT = /\.(mp4|webm|ogg|mp3|wav|m4a|mov)(\?|#|$)/i;

const FETCH_TIMEOUT_MS = 20000;
const MAX_PARALLEL_DOWNLOADS = 8;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;   // 25 MB por arquivo
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;  // 250 MB no total
const MAX_IMPORT_DEPTH = 4;

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'font/woff': 'woff', 'font/woff2': 'woff2', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2',
  'application/x-font-ttf': 'ttf', 'application/x-font-otf': 'otf',
  'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'application/json': 'json', 'text/json': 'json'
};

/** Limites do crawler multi-página (mesmo domínio). */
const MAX_PAGES = 30;
const PAGE_SETTLE_MS = 1000;
const TAB_LOAD_TIMEOUT_MS = 45000;

/** URLs em que o Chrome proíbe injeção de script (regra de negócio nº 2 do PRD). */
const BLOCKED_URL_PATTERNS = [
  /^chrome:\/\//i, /^chrome-untrusted:\/\//i, /^edge:\/\//i, /^brave:\/\//i,
  /^opera:\/\//i, /^vivaldi:\/\//i, /^about:/i, /^devtools:\/\//i, /^view-source:/i,
  /^chrome-extension:\/\//i, /^moz-extension:\/\//i,
  /^https?:\/\/chrome\.google\.com\/webstore/i,
  /^https?:\/\/chromewebstore\.google\.com/i,
  /^https?:\/\/microsoftedge\.microsoft\.com\/addons/i,
  /^https?:\/\/addons\.mozilla\.org/i
];

// ---------------------------------------------------------------------------
// Estado + comunicação com o popup
// ---------------------------------------------------------------------------

let currentState = { state: 'idle', percent: 0, message: 'Pronto para clonar.', step: '' };
let keepAliveTimer = null;
let running = false;

/**
 * ZIP pronto em memória para o Plano B (download local).
 * Mantido no service worker — chrome.storage não aguenta ZIPs grandes com segurança.
 */
let pendingFallbackZip = null;

async function publish(patch) {
  currentState = { ...currentState, ...patch };
  // O popup pode estar fechado — nesse caso sendMessage rejeita e o erro é ignorado.
  chrome.runtime.sendMessage({ type: 'WEB_CLONER_PROGRESS', ...currentState }).catch(() => {});
  // Persistimos o estado para que, ao reabrir o popup, o usuário veja o progresso atual.
  try {
    await chrome.storage.session.set({ wclonerState: currentState });
  } catch { /* storage.session indisponível: irrelevante */ }
}

/**
 * O service worker pode ser encerrado após ~30s de ociosidade. Chamar uma API do Chrome
 * periodicamente mantém o worker vivo durante clones longos.
 */
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------------------------------------------------------------------------
// Utilitários de rede
// ---------------------------------------------------------------------------

function toAbsolute(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  const value = String(rawUrl).trim().replace(/^["']|["']$/g, '');
  if (!value) return null;
  if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
  if (/^(chrome-extension|moz-extension):/i.test(value)) return null;
  // Conteúdo de @import já processado volta com tokens no lugar das URLs; não retokenizar.
  if (value.startsWith('__WCLONE_')) return null;
  try {
    const url = new URL(value, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function timedFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // `credentials: 'include'` permite clonar assets de páginas autenticadas (o cookie do
    // site é enviado). Sem CORS aplicado, a resposta é legível mesmo sem cabeçalhos ACAO.
    return await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Executa `worker` sobre `items` com um limite de requisições simultâneas. */
async function runPool(items, limit, worker) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Registro unificado de assets
// ---------------------------------------------------------------------------

/**
 * Reúne os tokens criados pelo content.js (HTML) e os criados aqui (CSS) em um único mapa,
 * deduplicando por URL absoluta para que cada arquivo seja baixado uma só vez.
 */
function createRegistry() {
  const tokens = new Map();
  const byUrl = new Map();
  let seq = 0;

  function promoteKind(info, kind) {
    if (!kind || !info) return;
    if (kind === 'font' || kind === 'media' || kind === 'sprite') info.kind = kind;
  }

  function inferKind(abs, kind) {
    if (kind) return kind;
    if (FONT_EXT.test(abs)) return 'font';
    if (MEDIA_EXT.test(abs)) return 'media';
    return 'image';
  }

  return {
    tokens,
    /**
     * Importa tokens de uma página. Como cada content.js reinicia a numeração,
     * reescreve colisões e devolve um mapa pageToken → globalToken.
     */
    importPageTokens(pageTokens) {
      const remap = {};
      for (const [token, info] of Object.entries(pageTokens || {})) {
        if (!info || !info.url) continue;
        let global = byUrl.get(info.url);
        if (!global) {
          if (!tokens.has(token)) {
            global = token;
          } else {
            global = `__WCLONE_MERGED_${seq++}__`;
          }
          tokens.set(global, { url: info.url, kind: inferKind(info.url, info.kind) });
          byUrl.set(info.url, global);
        } else {
          promoteKind(tokens.get(global), info.kind);
        }
        if (global !== token) remap[token] = global;
      }
      return remap;
    },
    add(rawUrl, baseUrl, kind) {
      const abs = toAbsolute(rawUrl, baseUrl);
      if (!abs) return null;

      const existing = byUrl.get(abs);
      if (existing) {
        promoteKind(tokens.get(existing), kind);
        return existing;
      }

      const token = `__WCLONE_CSSASSET_${seq++}__`;
      byUrl.set(abs, token);
      tokens.set(token, { url: abs, kind: inferKind(abs, kind) });
      return token;
    },
    markFont(absUrl) {
      const token = byUrl.get(absUrl);
      if (token) tokens.get(token).kind = 'font';
    }
  };
}

// ---------------------------------------------------------------------------
// Pipeline de CSS
// ---------------------------------------------------------------------------

/**
 * Extração PROFUNDA de @font-face.
 *
 * Vai além do óbvio para achar arquivos de fonte:
 *  1. Todo `src: url(...)` dentro de blocos @font-face (inclusive aninhados em @media/@supports,
 *     já que um bloco @font-face nunca contém chaves internas).
 *  2. Custom properties (`--minha-fonte: url(....woff2)`), usadas por design systems.
 *  3. Qualquer url() cuja extensão seja de fonte, em qualquer propriedade.
 *
 * Retorna URLs absolutas para que o registro as classifique na pasta assets/fonts/.
 */
function extractFontFaceUrls(cssText, baseUrl) {
  const found = new Set();

  const fontFaceBlocks = cssText.match(/@font-face\s*\{[^}]*\}/gi) || [];
  for (const block of fontFaceBlocks) {
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let match;
    while ((match = urlRe.exec(block))) {
      const abs = toAbsolute(match[2], baseUrl);
      if (abs) found.add(abs);
    }
  }

  const varRe = /--[\w-]+\s*:\s*[^;{}]*?url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let varMatch;
  while ((varMatch = varRe.exec(cssText))) {
    const abs = toAbsolute(varMatch[2], baseUrl);
    if (abs && FONT_EXT.test(abs)) found.add(abs);
  }

  const anyUrlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let anyMatch;
  while ((anyMatch = anyUrlRe.exec(cssText))) {
    const abs = toAbsolute(anyMatch[2], baseUrl);
    if (abs && FONT_EXT.test(abs)) found.add(abs);
  }

  return found;
}

/**
 * Normaliza um bloco de CSS:
 *  - resolve @import recursivamente (baixando o arquivo importado);
 *  - marca as fontes encontradas;
 *  - troca cada url(...) por um token, SEMPRE resolvendo contra a base correta
 *    (o próprio arquivo .css, e não o documento — é isso que faz `../img/x.png`
 *     dentro de `/assets/css/app.css` apontar para o lugar certo).
 */
async function processCss(cssText, baseUrl, registry, depth, report) {
  // @charset só é válido na primeira linha do arquivo; ao concatenar folhas ele vira lixo.
  let text = cssText.replace(/@charset\s+["'][^"']*["']\s*;/gi, '');

  // 1) @import — precisa vir antes para que o conteúdo importado também seja processado.
  if (depth < MAX_IMPORT_DEPTH) {
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi;
    const imports = [];
    let match;
    while ((match = importRe.exec(text))) {
      imports.push({ raw: match[0], url: match[2] || match[4], conditions: (match[5] || '').trim() });
    }

    for (const item of imports) {
      const abs = toAbsolute(item.url, baseUrl);
      if (!abs) continue;
      let replacement = null;
      try {
        const response = await timedFetch(abs);
        if (response.ok) {
          const imported = await response.text();
          const processed = await processCss(imported, response.url || abs, registry, depth + 1, report);
          replacement = item.conditions
            ? `@media ${item.conditions} {\n${processed}\n}`
            : processed;
        }
      } catch { /* fallback tratado abaixo */ }

      // Fallback de CORS/rede. Não dá para reemitir o @import: a regra só é válida no topo
      // do arquivo e este texto vai para o meio do styles.css concatenado. Em vez disso a
      // folha vira um <link> remoto no <head> do index.html.
      if (replacement === null) {
        report.warn(`@import não pôde ser baixado: ${abs}`);
        report.fallbackStylesheet(abs, item.conditions);
        replacement = `/* Web Cloner: @import bloqueado, carregado via <link> remoto -> ${abs} */`;
      }
      text = text.replace(item.raw, () => replacement);
    }
  }

  // 2) Fontes: classificadas antes da tokenização genérica.
  for (const fontUrl of extractFontFaceUrls(text, baseUrl)) {
    registry.add(fontUrl, baseUrl, 'font');
  }

  // 3) Tokenização de todas as url().
  text = text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote, rawUrl) => {
    const token = registry.add(rawUrl, baseUrl, null);
    return token ? `url("${token}")` : whole;
  });

  return text;
}

/** Junta todas as folhas de estilo (inline + externas) em um único styles.css. */
async function buildStylesheet(cssParts, registry, report) {
  const chunks = [];

  for (const part of cssParts) {
    if (part.type === 'text') {
      const processed = await processCss(part.text, part.base, registry, 0, report);
      chunks.push(wrapMedia(processed, part.media));
      continue;
    }

    let processed = null;
    try {
      const response = await timedFetch(part.url);
      if (response.ok) {
        const text = await response.text();
        // A base é a URL FINAL (pós-redirecionamento) — essencial para caminhos relativos.
        processed = await processCss(text, response.url || part.url, registry, 0, report);
      }
    } catch { /* fallback tratado abaixo */ }

    if (processed === null) {
      report.warn(`Folha de estilo inacessível: ${part.url}`);
      // Fallback: um <link> remoto é injetado no <head>, então o clone continua estilizado
      // quando houver internet — sem quebrar a cascata do styles.css local.
      report.fallbackStylesheet(part.url, part.media);
      chunks.push(`/* Web Cloner: download bloqueado, mantida como <link> remoto -> ${part.url} */`);
      continue;
    }

    chunks.push(wrapMedia(processed, part.media));
  }

  return chunks.join('\n\n');
}

function wrapMedia(cssText, media) {
  const condition = (media || '').trim();
  if (!condition || condition.toLowerCase() === 'all') return cssText;
  return `@media ${condition} {\n${cssText}\n}`;
}

// ---------------------------------------------------------------------------
// Download dos assets e nomes de arquivo
// ---------------------------------------------------------------------------

function buildFileName(url, contentType, kind, usedNames) {
  let base = '';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch { /* nome gerado abaixo */ }

  base = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!base) {
    base = kind === 'font' ? 'fonte' : kind === 'media' ? 'midia' : 'imagem';
  }

  const dotIndex = base.lastIndexOf('.');
  let stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
  let ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : '';

  if (!/^[a-z0-9]{2,5}$/.test(ext)) {
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    ext = MIME_EXT[mime] || (kind === 'font' ? 'woff2' : kind === 'media' ? 'mp4' : 'png');
  }

  stem = stem.slice(0, 60) || (kind === 'font' ? 'fonte' : kind === 'media' ? 'midia' : 'imagem');

  let candidate = `${stem}.${ext}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${stem}-${counter++}.${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Baixa todos os assets registrados e devolve o mapa token -> caminho no ZIP
 * (sem prefixo ./ — o prefixo relativo é aplicado por página).
 */
async function downloadAssets(registry, zip, report, onProgress) {
  const entries = Array.from(registry.tokens.entries());
  const resolved = new Map();
  const usedNames = { image: new Set(), font: new Set(), media: new Set() };
  const pathByUrl = new Map();
  const sprites = new Map();

  let completed = 0;
  let totalBytes = 0;
  let okCount = 0;
  let failCount = 0;

  await runPool(entries, MAX_PARALLEL_DOWNLOADS, async ([token, info]) => {
    if (pathByUrl.has(info.url)) {
      resolved.set(token, pathByUrl.get(info.url));
      completed++;
      onProgress(completed, entries.length);
      return;
    }

    try {
      const response = await timedFetch(info.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) throw new Error('resposta vazia');
      if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error('arquivo grande demais');
      if (totalBytes + buffer.byteLength > MAX_TOTAL_BYTES) throw new Error('limite total atingido');

      const contentType = response.headers.get('content-type') || '';
      if (/^text\/html/i.test(contentType)) throw new Error('resposta HTML inesperada');

      const isFont = info.kind === 'font' || /^(font|application\/(x-)?font)/i.test(contentType);
      const isMedia =
        info.kind === 'media' ||
        /^(video|audio)\//i.test(contentType);
      const kind = isFont ? 'font' : isMedia ? 'media' : 'image';
      const folder = kind === 'font' ? 'fonts' : kind === 'media' ? 'media' : 'images';
      const fileName = buildFileName(info.url, contentType, kind, usedNames[kind]);
      const zipPath = `assets/${folder}/${fileName}`;

      zip.file(zipPath, buffer);
      totalBytes += buffer.byteLength;
      okCount++;

      if (info.kind === 'sprite' && (/svg/i.test(contentType) || /\.svg$/i.test(zipPath))) {
        sprites.set(info.url, { text: new TextDecoder('utf-8').decode(buffer), path: zipPath });
      }

      pathByUrl.set(info.url, zipPath);
      resolved.set(token, zipPath);
    } catch (error) {
      failCount++;
      report.warn(`Asset mantido como URL remota (${error.message}): ${info.url}`);
      pathByUrl.set(info.url, info.url);
      resolved.set(token, info.url);
    } finally {
      completed++;
      onProgress(completed, entries.length);
    }
  });

  return { resolved, okCount, failCount, totalBytes, sprites };
}

/**
 * Embute os sprites SVG baixados diretamente no HTML e reescreve as referências
 * `./assets/images/sprite.svg#icone` para o fragmento local `#icone`.
 * Sem isso, ícones que usam <use href="externo.svg#id"> aparecem vazios ao abrir o
 * arquivo salvo, porque o navegador trata cada arquivo local como uma origem distinta.
 */
function inlineSvgSprites(html, sprites) {
  if (!sprites.size) return html;

  const symbols = [];
  for (const [url, sprite] of sprites) {
    const inner = sprite.text.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
    if (!inner) continue;
    symbols.push(inner[1]);

    // Todas as ocorrências do caminho do sprite viram referências internas (#icone).
    for (const candidate of new Set([sprite.path, url])) {
      html = html.split(`${candidate}#`).join('#');
    }
  }

  if (!symbols.length) return html;

  const block =
    `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">` +
    `${symbols.join('\n')}</svg>`;

  const bodyTag = html.match(/<body[^>]*>/i);
  return bodyTag
    ? html.replace(bodyTag[0], `${bodyTag[0]}\n${block}`)
    : `${block}\n${html}`;
}

// ---------------------------------------------------------------------------
// Substituição dos tokens
// ---------------------------------------------------------------------------

/**
 * Troca os tokens pelo caminho final.
 * `pathPrefix` (ex.: "./" ou "../") é aplicado só em caminhos locais do ZIP.
 */
function replaceTokens(text, resolved, { escapeHtml, pathPrefix = './' }) {
  return text.replace(ASSET_TOKEN_RE, (token) => {
    const value = resolved.get(token);
    if (value === undefined) return token;
    const path = /^https?:\/\//i.test(value) || value.startsWith('data:')
      ? value
      : `${pathPrefix}${value.replace(/^\.\//, '')}`;
    const safe = path.replace(/"/g, '%22').replace(/'/g, '%27');
    return escapeHtml ? safe.replace(/</g, '%3C').replace(/>/g, '%3E') : safe;
  });
}

function applyTokenRemap(text, remap) {
  let out = text;
  for (const [from, to] of Object.entries(remap || {})) {
    if (from && to && from !== to) out = out.split(from).join(to);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePageUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    if (/\/index\.html?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/index\.html?$/i, '/');
    }
    return u.href;
  } catch {
    return null;
  }
}

function pageUrlToZipPath(pageUrl, rootUrl) {
  const pageKey = normalizePageUrl(pageUrl);
  const rootKey = normalizePageUrl(rootUrl);
  if (!pageKey) return 'index.html';
  if (pageKey === rootKey) return 'index.html';

  let path = '/';
  try {
    path = new URL(pageUrl).pathname || '/';
  } catch {
    return 'index.html';
  }

  if (path === '/' || path === '') return 'index.html';
  if (/\.html?$/i.test(path)) return path.replace(/^\//, '');
  if (path.endsWith('/')) return `${path.replace(/^\//, '')}index.html`;
  return `${path.replace(/^\//, '')}/index.html`;
}

function depthPrefix(zipHtmlPath) {
  const depth = zipHtmlPath.split('/').length - 1;
  return depth <= 0 ? './' : '../'.repeat(depth);
}

function relativeLink(fromZip, toZip) {
  const fromDir = fromZip.includes('/') ? fromZip.slice(0, fromZip.lastIndexOf('/') + 1) : '';
  const fromParts = fromDir ? fromDir.replace(/\/$/, '').split('/').filter(Boolean) : [];
  const toParts = toZip.split('/');
  const toFile = toParts.pop();
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const ups = '../'.repeat(fromParts.length - i);
  const down = [...toParts.slice(i), toFile].join('/');
  const rel = `${ups}${down}`;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function rewriteInternalLinks(html, pageZipPath, urlToZipPath) {
  let out = html;
  const entries = Array.from(urlToZipPath.entries()).sort((a, b) => b[0].length - a[0].length);

  for (const [absUrl, targetZip] of entries) {
    const rel = relativeLink(pageZipPath, targetZip);
    const variants = new Set();

    try {
      const u = new URL(absUrl);
      variants.add(u.href);
      const noSlash = u.origin + u.pathname.replace(/\/$/, '') + u.search;
      const withSlash = u.origin + (u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`) + u.search;
      variants.add(noSlash);
      variants.add(withSlash);
      // Pathname relativo só se for específico o bastante (evita trocar "/" em todo o HTML).
      if (u.pathname && u.pathname !== '/' && u.pathname.length > 1) {
        variants.add(u.pathname + u.search);
        if (!u.pathname.endsWith('/')) variants.add(`${u.pathname}/` + u.search);
      }
    } catch {
      if (absUrl && absUrl.length > 8) variants.add(absUrl);
    }

    for (const variant of variants) {
      if (!variant || variant.length < 8) continue;
      out = out.split(variant).join(rel);
    }
  }
  return out;
}

async function waitTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') {
    await sleep(PAGE_SETTLE_MS);
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timeout ao carregar a página para clonagem.'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  await sleep(PAGE_SETTLE_MS);
}

async function extractFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    throw new Error(describeInjectionError(error, tab?.url || ''));
  }

  const response = await chrome.tabs.sendMessage(tabId, { type: 'WEB_CLONER_EXTRACT' });
  if (!response) throw new Error('A página não respondeu à extração. Recarregue e tente novamente.');
  if (!response.ok) throw new Error(`Falha na extração do DOM: ${response.error}`);
  return response.payload;
}

// ---------------------------------------------------------------------------
// Empacotamento, upload ao painel e download de emergência
// ---------------------------------------------------------------------------

function buildZipFileName(pageUrl) {
  let host = 'pagina';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '') || 'pagina';
  } catch { /* usa o padrão */ }

  const slug = host.replace(/[^a-zA-Z0-9.-]+/g, '-').slice(0, 40);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `clone-${slug}-${stamp}.zip`;
}

/** Converte o base64 do ZIP em Blob para montar o FormData do upload. */
function base64ToBlob(base64, type = 'application/zip') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * POST FormData { title, url, file } para o Painel Next.js.
 * Valida response.ok e o JSON { success } — qualquer falha sobe para o Plano B.
 */
async function uploadCloneToPanel({ title, url, fileName, blob }) {
  const form = new FormData();
  form.append('title', title || 'Sem título');
  form.append('url', url || '');
  form.append('file', blob, fileName);

  const headers = {};
  if (CLONE_API_SECRET) headers['X-Clone-Secret'] = CLONE_API_SECRET;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      body: form,
      headers,
      signal: controller.signal
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* corpo não-JSON (proxy, HTML de erro, etc.) */
    }

    if (!response.ok) {
      const detail = payload?.error || `HTTP ${response.status}`;
      throw new Error(`Painel respondeu com erro: ${detail}`);
    }

    if (payload && payload.success === false) {
      throw new Error(payload.error || 'Upload rejeitado pelo painel.');
    }

    return payload || { success: true };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Tempo esgotado ao enviar para o painel. Verifique se o servidor está no ar.');
    }
    // Failed to fetch / network offline / CORS / painel fora do ar
    if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(String(error?.message || error))) {
      throw new Error(
        `Não foi possível conectar ao painel (${API_URL}). Confirme se o Next.js está rodando.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Criar uma URL de Blob para o download de emergência do .zip, já que URL.createObjectURL não existe no service worker.'
  });
}

/**
 * PLANO B — download local via chrome.downloads.
 * Usado somente quando o upload ao painel falha (ou o usuário pede manualmente).
 */
async function triggerDownload(base64, filename) {
  try {
    await ensureOffscreenDocument();
    const blobUrl = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'WEB_CLONER_CREATE_BLOB_URL',
      base64
    });
    if (!blobUrl || typeof blobUrl !== 'string') throw new Error('offscreen não retornou URL');

    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
    revokeWhenFinished(downloadId, blobUrl);
    return downloadId;
  } catch (error) {
    console.warn('[Web Cloner] Offscreen indisponível, usando data: URL.', error);
    return chrome.downloads.download({
      url: `data:application/zip;base64,${base64}`,
      filename,
      saveAs: false
    });
  }
}

function revokeWhenFinished(downloadId, blobUrl) {
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === 'in_progress') return;
    chrome.downloads.onChanged.removeListener(listener);
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'WEB_CLONER_REVOKE_BLOB_URL', blobUrl })
      .catch(() => {});
    chrome.offscreen.closeDocument().catch(() => {});
  };
  chrome.downloads.onChanged.addListener(listener);
}

async function runFallbackDownload() {
  if (!pendingFallbackZip?.base64 || !pendingFallbackZip?.fileName) {
    throw new Error('Não há ZIP disponível para download de emergência. Clone a página novamente.');
  }
  await triggerDownload(pendingFallbackZip.base64, pendingFallbackZip.fileName);
  return pendingFallbackZip.fileName;
}

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------

function describeInjectionError(error, url) {
  const message = String(error?.message || error);
  if (/cannot be scripted|Cannot access|chrome:\/\/|extension manifest|showing error page/i.test(message)) {
    return 'Esta página é protegida pelo navegador e não permite a injeção de scripts. Abra um site comum (http/https) e tente novamente.';
  }
  if (/No tab with id/i.test(message)) return 'A aba foi fechada durante a clonagem.';
  if (/frame was removed|Frame with ID/i.test(message)) return 'A página foi recarregada durante a clonagem. Tente novamente.';
  return `Não foi possível acessar o conteúdo de ${url || 'a página'}: ${message}`;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function clonePage(tabId) {
  const warnings = [];
  const fallbackStylesheets = new Map();

  const report = {
    warn(text) {
      if (warnings.length < 200) warnings.push(text);
    },
    fallbackStylesheet(url, media) {
      if (!fallbackStylesheets.has(url)) fallbackStylesheets.set(url, (media || '').trim());
    }
  };

  const startTab = await chrome.tabs.get(tabId);
  if (!startTab || !startTab.url) throw new Error('Não foi possível identificar a aba ativa.');
  if (BLOCKED_URL_PATTERNS.some((re) => re.test(startTab.url))) {
    throw new Error('Esta página é protegida pelo navegador (chrome://, Web Store ou similar) e não pode ser clonada.');
  }

  const rootUrl = startTab.url;
  const rootOrigin = new URL(rootUrl).origin;
  const registry = createRegistry();
  const zip = new JSZip();
  const allCssParts = [];
  const capturedPages = [];
  const urlToZipPath = new Map();
  const visited = new Set();
  const queue = [rootUrl];

  let aggregateStats = {
    shadowRoots: 0,
    canvases: 0,
    formFields: 0,
    scriptsRemoved: 0,
    adsRemoved: 0,
    injectedRemoved: 0,
    computedBackgrounds: 0
  };

  await publish({
    state: 'running',
    percent: 4,
    step: 'crawl',
    message: 'Iniciando captura do site (multi-página)…'
  });

  while (queue.length && capturedPages.length < MAX_PAGES) {
    const nextUrl = queue.shift();
    const key = normalizePageUrl(nextUrl);
    if (!key || visited.has(key)) continue;

    let pageOrigin = '';
    try {
      pageOrigin = new URL(key).origin;
    } catch {
      continue;
    }
    if (pageOrigin !== rootOrigin) continue;
    if (BLOCKED_URL_PATTERNS.some((re) => re.test(key))) continue;

    visited.add(key);
    const pageIndex = capturedPages.length + 1;
    const isFirst = capturedPages.length === 0;

    await publish({
      state: 'running',
      percent: 4 + Math.min(48, Math.round((capturedPages.length / MAX_PAGES) * 48)),
      step: 'crawl',
      message: `Capturando página ${pageIndex}… ${key.replace(rootOrigin, '') || '/'}`
    });

    let workerTabId = null;
    let payload = null;

    try {
      if (isFirst) {
        workerTabId = tabId;
        await publish({ state: 'running', percent: 8, step: 'dom', message: 'Analisando DOM da página inicial…' });
        payload = await extractFromTab(workerTabId);
      } else {
        const created = await chrome.tabs.create({ url: key, active: false });
        workerTabId = created.id;
        await waitTabComplete(workerTabId);
        payload = await extractFromTab(workerTabId);
      }
    } catch (error) {
      report.warn(`Página ignorada (${error.message}): ${key}`);
      if (!isFirst && workerTabId) {
        try { await chrome.tabs.remove(workerTabId); } catch { /* ignore */ }
      }
      if (isFirst) throw error;
      continue;
    } finally {
      if (!isFirst && workerTabId) {
        try { await chrome.tabs.remove(workerTabId); } catch { /* ignore */ }
      }
    }

    const pageZipPath = pageUrlToZipPath(payload.pageUrl || key, rootUrl);
    urlToZipPath.set(normalizePageUrl(payload.pageUrl || key), pageZipPath);
    try {
      urlToZipPath.set(new URL(payload.pageUrl || key).href, pageZipPath);
    } catch { /* ignore */ }

    const remap = registry.importPageTokens(payload.assets);
    let html = applyTokenRemap(payload.html, remap);

    if (Array.isArray(payload.cssParts)) {
      for (const part of payload.cssParts) allCssParts.push(part);
    }

    for (const [k, v] of Object.entries(payload.stats || {})) {
      if (typeof v === 'number') aggregateStats[k] = (aggregateStats[k] || 0) + v;
    }

    capturedPages.push({
      zipPath: pageZipPath,
      html,
      pageUrl: payload.pageUrl || key,
      pageTitle: payload.pageTitle || '',
      stats: payload.stats || {}
    });

    for (const link of payload.internalLinks || []) {
      const normalized = normalizePageUrl(link);
      if (!normalized || visited.has(normalized)) continue;
      try {
        if (new URL(normalized).origin !== rootOrigin) continue;
      } catch {
        continue;
      }
      if (!queue.includes(normalized) && capturedPages.length + queue.length < MAX_PAGES * 2) {
        queue.push(normalized);
      }
    }
  }

  if (!capturedPages.length) {
    throw new Error('Nenhuma página pôde ser capturada.');
  }

  await publish({
    state: 'running',
    percent: 54,
    step: 'css',
    message: `Consolidando CSS (${allCssParts.length} folhas) de ${capturedPages.length} página(s)…`
  });

  // Evita repetir a mesma folha externa em cada página do crawl.
  const dedupedCss = [];
  const seenCssLinks = new Set();
  const seenCssText = new Set();
  for (const part of allCssParts) {
    if (part.type === 'link') {
      if (!part.url || seenCssLinks.has(part.url)) continue;
      seenCssLinks.add(part.url);
      dedupedCss.push(part);
      continue;
    }
    const textKey = `${(part.text || '').length}:${(part.text || '').slice(0, 120)}`;
    if (seenCssText.has(textKey)) continue;
    seenCssText.add(textKey);
    dedupedCss.push(part);
  }

  let css = await buildStylesheet(dedupedCss, registry, report);

  const assetCount = registry.tokens.size;
  await publish({
    state: 'running',
    percent: 60,
    step: 'assets',
    message: `Baixando ${assetCount} assets (imagens, fontes e mídia)…`
  });

  const { resolved, okCount, failCount, totalBytes, sprites } = await downloadAssets(
    registry,
    zip,
    report,
    (done, total) => {
      if (done !== total && done % 3 !== 0) return;
      publish({
        state: 'running',
        percent: 60 + Math.round((done / Math.max(total, 1)) * 22),
        step: 'assets',
        message: `Baixando assets… ${done}/${total}`
      });
    }
  );

  await publish({ state: 'running', percent: 84, step: 'rewrite', message: 'Montando páginas e caminhos relativos…' });

  const fallbackTags = Array.from(fallbackStylesheets.entries())
    .map(([url, media]) => {
      const mediaAttr = media && media.toLowerCase() !== 'all' ? ` media="${escapeAttribute(media)}"` : '';
      return `<link rel="stylesheet" href="${escapeAttribute(url)}"${mediaAttr}>`;
    })
    .join('\n');

  for (const page of capturedPages) {
    const prefix = depthPrefix(page.zipPath);
    let html = replaceTokens(page.html, resolved, { escapeHtml: true, pathPrefix: prefix });
    html = inlineSvgSprites(html, sprites);
    html = html.replace('<!--__WCLONE_FALLBACK_LINKS__-->', fallbackTags);
    html = html.split('__WCLONE_STYLES_HREF__').join(`${prefix}styles.css`);
    html = rewriteInternalLinks(html, page.zipPath, urlToZipPath);
    zip.file(page.zipPath, html);
  }

  css = replaceTokens(css, resolved, { escapeHtml: false, pathPrefix: './' });
  zip.file(
    'styles.css',
    `/* Clone de ${rootUrl} — ${capturedPages.length} página(s) — ${new Date().toISOString()} */\n\n${css}`
  );

  zip.file(
    'README.txt',
    [
      'Clone gerado pela extensão "Web Cloner Avançado".',
      '',
      `Origem........: ${rootUrl}`,
      `Título........: ${capturedPages[0].pageTitle}`,
      `Gerado em.....: ${new Date().toLocaleString()}`,
      `Páginas.......: ${capturedPages.length}`,
      '',
      'Conteúdo:',
      '  index.html (+ pastas) — páginas do mesmo domínio',
      '  styles.css            — folhas de estilo consolidadas',
      '  assets/images/        — imagens',
      '  assets/fonts/         — fontes',
      '  assets/media/         — vídeos/áudios',
      '',
      'Páginas capturadas:',
      ...capturedPages.map((p) => `  - ${p.zipPath}  ←  ${p.pageUrl}`),
      '',
      'Estatísticas:',
      `  Shadow roots achatados....: ${aggregateStats.shadowRoots}`,
      `  Canvas convertidos........: ${aggregateStats.canvases}`,
      `  Campos de formulário......: ${aggregateStats.formFields}`,
      `  Backgrounds computados....: ${aggregateStats.computedBackgrounds || 0}`,
      `  Scripts removidos.........: ${aggregateStats.scriptsRemoved}`,
      `  Anúncios/iframes removidos: ${aggregateStats.adsRemoved}`,
      `  Assets baixados...........: ${okCount}`,
      `  Assets mantidos remotos...: ${failCount}`,
      '',
      failCount
        ? 'Alguns assets não puderam ser baixados (CORS, hotlink ou 404).\nURLs absolutas originais foram preservadas.'
        : 'Todos os assets foram baixados com sucesso.',
      '',
      warnings.length ? 'Avisos:\n' + warnings.map((w) => `  - ${w}`).join('\n') : ''
    ].join('\n')
  );

  await publish({ state: 'running', percent: 88, step: 'zip', message: 'Gerando ZIP…' });
  const base64 = await zip.generateAsync(
    { type: 'base64', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => {
      if (Math.round(meta.percent) % 10 !== 0) return;
      publish({
        state: 'running',
        percent: 88 + Math.round(meta.percent * 0.06),
        step: 'zip',
        message: `Gerando ZIP… ${Math.round(meta.percent)}%`
      });
    }
  );

  const fileName = buildZipFileName(rootUrl);
  const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1);
  const summaryBase = {
    fileName,
    pages: capturedPages.length,
    assetsOk: okCount,
    assetsFailed: failCount,
    sizeMb,
    shadowRoots: aggregateStats.shadowRoots,
    canvases: aggregateStats.canvases,
    stylesheets: dedupedCss.length,
    panelUrl: PANEL_URL
  };

  pendingFallbackZip = { base64, fileName };

  await publish({
    state: 'running',
    percent: 95,
    step: 'upload',
    message: 'Enviando para o Painel…'
  });

  try {
    const blob = base64ToBlob(base64);
    await uploadCloneToPanel({
      title: capturedPages[0].pageTitle || startTab.title || 'Sem título',
      url: rootUrl,
      fileName,
      blob
    });

    pendingFallbackZip = null;

    await publish({
      state: 'done',
      percent: 100,
      step: 'done',
      message: `Sucesso! ${capturedPages.length} página(s) salvas no Painel.`,
      canFallbackDownload: false,
      summary: { ...summaryBase, uploaded: true }
    });
  } catch (uploadError) {
    console.warn('[Web Cloner] Upload ao painel falhou — fallback disponível.', uploadError);
    await publish({
      state: 'error',
      percent: 100,
      step: 'error',
      message: uploadError?.message || 'Falha ao enviar para o painel.',
      canFallbackDownload: true,
      fileName,
      summary: { ...summaryBase, uploaded: false }
    });
  }
}

// ---------------------------------------------------------------------------
// Roteamento de mensagens
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return undefined;

  if (message.type === 'WEB_CLONER_GET_STATE') {
    sendResponse({
      ...currentState,
      canFallbackDownload: Boolean(pendingFallbackZip),
      panelUrl: PANEL_URL
    });
    return undefined;
  }

  if (message.type === 'WEB_CLONER_START') {
    if (running) {
      sendResponse({ ok: false, error: 'Já existe uma clonagem em andamento.' });
      return undefined;
    }

    running = true;
    pendingFallbackZip = null;
    startKeepAlive();
    sendResponse({ ok: true });

    clonePage(message.tabId)
      .catch((error) => {
        console.error('[Web Cloner] Falha na clonagem:', error);
        return publish({
          state: 'error',
          percent: 100,
          step: 'error',
          message: error?.message || 'Erro inesperado durante a clonagem.',
          canFallbackDownload: Boolean(pendingFallbackZip)
        });
      })
      .finally(() => {
        running = false;
        stopKeepAlive();
      });

    return undefined;
  }

  if (message.type === 'WEB_CLONER_FALLBACK_DOWNLOAD') {
    runFallbackDownload()
      .then((fileName) => {
        sendResponse({ ok: true, fileName });
        return publish({
          ...currentState,
          message: `ZIP salvo localmente: ${fileName}`,
          fallbackDownloaded: true
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true; // resposta assíncrona
  }

  if (message.type === 'WEB_CLONER_RESET') {
    pendingFallbackZip = null;
    publish({
      state: 'idle',
      percent: 0,
      step: '',
      message: 'Pronto para clonar.',
      summary: null,
      canFallbackDownload: false,
      fileName: null,
      fallbackDownloaded: false
    });
    sendResponse({ ok: true });
  }

  return undefined;
});
