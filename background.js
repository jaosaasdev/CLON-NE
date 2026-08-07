/**
 * background.js — Service worker (Manifest V3).
 *
 * Orquestra o pipeline de clonagem:
 *   popup  ->  content.js  ->  CSS/assets  ->  JSZip
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

const ASSET_TOKEN_RE = /__WCLONE_(?:ASSET|CSSASSET)_\d+__/g;
const FONT_EXT = /\.(woff2?|ttf|otf|eot|sfnt)(\?|#|$)/i;

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
  'application/vnd.ms-fontobject': 'eot'
};

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
function createRegistry(initialTokens) {
  const tokens = new Map();
  const byUrl = new Map();
  let seq = 0;

  for (const [token, info] of Object.entries(initialTokens || {})) {
    if (!info || !info.url) continue;
    tokens.set(token, { url: info.url, kind: info.kind || 'image' });
    if (!byUrl.has(info.url)) byUrl.set(info.url, token);
  }

  return {
    tokens,
    add(rawUrl, baseUrl, kind) {
      const abs = toAbsolute(rawUrl, baseUrl);
      if (!abs) return null;

      const existing = byUrl.get(abs);
      if (existing) {
        if (kind === 'font') tokens.get(existing).kind = 'font';
        return existing;
      }

      const token = `__WCLONE_CSSASSET_${seq++}__`;
      byUrl.set(abs, token);
      tokens.set(token, { url: abs, kind: kind || (FONT_EXT.test(abs) ? 'font' : 'image') });
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
  if (!base) base = kind === 'font' ? 'fonte' : 'imagem';

  const dotIndex = base.lastIndexOf('.');
  let stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
  let ext = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : '';

  if (!/^[a-z0-9]{2,5}$/.test(ext)) {
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    ext = MIME_EXT[mime] || (kind === 'font' ? 'woff2' : 'png');
  }

  stem = stem.slice(0, 60) || (kind === 'font' ? 'fonte' : 'imagem');

  let candidate = `${stem}.${ext}`;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${stem}-${counter++}.${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Baixa todos os assets registrados e devolve o mapa token -> substituição final.
 * Sucesso  -> caminho relativo dentro do .zip.
 * Falha    -> URL absoluta original (fallback silencioso exigido pelo PRD).
 */
async function downloadAssets(registry, zip, report, onProgress) {
  const entries = Array.from(registry.tokens.entries());
  const resolved = new Map();
  const usedNames = { image: new Set(), font: new Set() };
  const pathByUrl = new Map();
  const sprites = new Map();

  let completed = 0;
  let totalBytes = 0;
  let okCount = 0;
  let failCount = 0;

  await runPool(entries, MAX_PARALLEL_DOWNLOADS, async ([token, info]) => {
    // Deduplicação: a mesma URL pode ter recebido tokens diferentes em HTML e CSS.
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
      // Uma resposta HTML normalmente significa página de erro/login, não o asset.
      if (/^text\/html/i.test(contentType)) throw new Error('resposta HTML inesperada');

      const isFont = info.kind === 'font' || /^(font|application\/(x-)?font)/i.test(contentType);
      const folder = isFont ? 'fonts' : 'images';
      const fileName = buildFileName(info.url, contentType, isFont ? 'font' : 'image', usedNames[isFont ? 'font' : 'image']);
      const zipPath = `assets/${folder}/${fileName}`;

      zip.file(zipPath, buffer);
      totalBytes += buffer.byteLength;
      okCount++;

      // Sprites SVG referenciados por <use> são guardados como texto para serem embutidos
      // no index.html (um <use> apontando para arquivo externo não funciona em file://).
      if (info.kind === 'sprite' && (/svg/i.test(contentType) || /\.svg$/i.test(zipPath))) {
        sprites.set(info.url, { text: new TextDecoder('utf-8').decode(buffer), path: `./${zipPath}` });
      }

      // Caminho relativo válido tanto a partir de /index.html quanto de /styles.css.
      const relative = `./${zipPath}`;
      pathByUrl.set(info.url, relative);
      resolved.set(token, relative);
    } catch (error) {
      // REGRA DE NEGÓCIO: falhas de CORS/rede são silenciosas; mantemos a URL absoluta.
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
 * Em HTML escapamos apenas `"`, `<` e `>`: o `&` é deixado intacto de propósito, porque o
 * mesmo texto pode estar dentro de um <style> (onde entidades HTML não são interpretadas)
 * e porque o parser HTML5 já trata `&param=` literalmente dentro de atributos.
 */
function replaceTokens(text, resolved, { escapeHtml }) {
  return text.replace(ASSET_TOKEN_RE, (token) => {
    const value = resolved.get(token);
    if (value === undefined) return token;
    // Aspas são percent-encodadas para nunca fecharem o atributo HTML nem o url() do CSS.
    const safe = value.replace(/"/g, '%22').replace(/'/g, '%27');
    return escapeHtml ? safe.replace(/</g, '%3C').replace(/>/g, '%3E') : safe;
  });
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
    /** Registra uma folha de estilo que não pôde ser baixada e vira <link> remoto. */
    fallbackStylesheet(url, media) {
      if (!fallbackStylesheets.has(url)) fallbackStylesheets.set(url, (media || '').trim());
    }
  };

  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url) throw new Error('Não foi possível identificar a aba ativa.');
  if (BLOCKED_URL_PATTERNS.some((re) => re.test(tab.url))) {
    throw new Error('Esta página é protegida pelo navegador (chrome://, Web Store ou similar) e não pode ser clonada.');
  }

  await publish({ state: 'running', percent: 6, step: 'inject', message: 'Injetando o motor de captura…' });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    throw new Error(describeInjectionError(error, tab.url));
  }

  await publish({ state: 'running', percent: 14, step: 'dom', message: 'Analisando DOM, Shadow DOM e formulários…' });
  const response = await chrome.tabs.sendMessage(tabId, { type: 'WEB_CLONER_EXTRACT' });
  if (!response) throw new Error('A página não respondeu à extração. Recarregue a aba e tente novamente.');
  if (!response.ok) throw new Error(`Falha na extração do DOM: ${response.error}`);

  const payload = response.payload;
  const registry = createRegistry(payload.assets);
  const zip = new JSZip();

  await publish({
    state: 'running',
    percent: 26,
    step: 'css',
    message: `Consolidando CSS (${payload.cssParts.length} folhas) e extraindo @font-face…`
  });
  let css = await buildStylesheet(payload.cssParts, registry, report);

  const assetCount = registry.tokens.size;
  await publish({
    state: 'running',
    percent: 38,
    step: 'assets',
    message: `Baixando ${assetCount} assets (imagens e fontes)…`
  });

  const { resolved, okCount, failCount, totalBytes, sprites } = await downloadAssets(
    registry,
    zip,
    report,
    (done, total) => {
      // Publica no máximo a cada 3 arquivos para não inundar o storage/popup.
      if (done !== total && done % 3 !== 0) return;
      publish({
        state: 'running',
        percent: 38 + Math.round((done / Math.max(total, 1)) * 40),
        step: 'assets',
        message: `Baixando assets… ${done}/${total}`
      });
    }
  );

  await publish({ state: 'running', percent: 82, step: 'rewrite', message: 'Reescrevendo caminhos relativos…' });
  let html = replaceTokens(payload.html, resolved, { escapeHtml: true });
  css = replaceTokens(css, resolved, { escapeHtml: false });
  html = inlineSvgSprites(html, sprites);

  // Substitui o marcador deixado pelo content.js pelos <link> das folhas não baixadas.
  const fallbackTags = Array.from(fallbackStylesheets.entries())
    .map(([url, media]) => {
      const mediaAttr = media && media.toLowerCase() !== 'all' ? ` media="${escapeAttribute(media)}"` : '';
      return `<link rel="stylesheet" href="${escapeAttribute(url)}"${mediaAttr}>`;
    })
    .join('\n');
  html = html.replace('<!--__WCLONE_FALLBACK_LINKS__-->', fallbackTags);

  zip.file('index.html', html);
  zip.file('styles.css', `/* Clone de ${payload.pageUrl} — gerado em ${new Date().toISOString()} */\n\n${css}`);
  zip.file(
    'README.txt',
    [
      'Clone gerado pela extensão "Web Cloner Avançado".',
      '',
      `Origem........: ${payload.pageUrl}`,
      `Título........: ${payload.pageTitle}`,
      `Gerado em.....: ${new Date().toLocaleString()}`,
      '',
      'Conteúdo:',
      '  index.html          — DOM tratado (formulários, canvas e shadow DOM já resolvidos)',
      '  styles.css          — todas as folhas de estilo consolidadas',
      '  assets/images/      — imagens baixadas',
      '  assets/fonts/       — fontes baixadas',
      '',
      'Estatísticas da captura:',
      `  Shadow roots achatados....: ${payload.stats.shadowRoots}`,
      `  Canvas convertidos........: ${payload.stats.canvases}`,
      `  Campos de formulário......: ${payload.stats.formFields}`,
      `  Scripts removidos.........: ${payload.stats.scriptsRemoved}`,
      `  Anúncios/iframes removidos: ${payload.stats.adsRemoved}`,
      `  Assets baixados...........: ${okCount}`,
      `  Assets mantidos remotos...: ${failCount}`,
      '',
      failCount
        ? 'Alguns assets não puderam ser baixados (CORS, hotlink protection ou 404).\nSuas URLs absolutas originais foram preservadas no HTML/CSS.'
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

  const fileName = buildZipFileName(payload.pageUrl);
  const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1);
  const summaryBase = {
    fileName,
    assetsOk: okCount,
    assetsFailed: failCount,
    sizeMb,
    shadowRoots: payload.stats.shadowRoots,
    canvases: payload.stats.canvases,
    stylesheets: payload.cssParts.length,
    panelUrl: PANEL_URL
  };

  // Guarda o ZIP em memória ANTES do upload — se o painel falhar, o Plano B ainda funciona.
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
      title: payload.pageTitle || tab.title || 'Sem título',
      url: payload.pageUrl || tab.url,
      fileName,
      blob
    });

    // Sucesso no painel: limpa o fallback (não precisa mais do download local).
    pendingFallbackZip = null;

    await publish({
      state: 'done',
      percent: 100,
      step: 'done',
      message: 'Sucesso! Site salvo no seu Painel.',
      canFallbackDownload: false,
      summary: { ...summaryBase, uploaded: true }
    });
  } catch (uploadError) {
    // PLANO B: mantém o ZIP e sinaliza a UI para oferecer "Baixar ZIP Manualmente".
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
