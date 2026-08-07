/**
 * content.js — Motor de captura executado DENTRO da página alvo.
 *
 * Responsabilidades:
 *  1. Clonar o DOM vivo e aplicar transformações "de estado" (formulários, canvas, shadow DOM).
 *  2. Limpar sujeira (scripts, iframes de anúncio, nós injetados por outras extensões).
 *  3. Coletar todo o CSS da página (tags <style>, <link rel=stylesheet> e folhas adotadas via CSSOM).
 *  4. Trocar toda URL de asset por um TOKEN determinístico e devolver o mapa token -> URL absoluta.
 *
 * Por que TOKENS em vez de reescrever caminhos aqui?
 *  - O download dos assets acontece no service worker (única camada que ignora CORS).
 *    Só lá saberemos se cada asset foi baixado com sucesso.
 *  - Com tokens, o background faz uma simples substituição de string no HTML/CSS final:
 *      sucesso  -> "./assets/images/logo.png"   (caminho relativo dentro do .zip)
 *      falha    -> "https://cdn.site.com/logo.png" (fallback: mantém a URL absoluta original)
 *    Isso evita parsear HTML com regex e implementa a regra de negócio de fallback de CORS
 *    em um único ponto do código.
 */

(() => {
  'use strict';

  // O script é injetado via chrome.scripting.executeScript a cada clique.
  // Esta trava evita registrar o listener de mensagens múltiplas vezes na mesma aba.
  if (window.__WEB_CLONER_ENGINE_READY__) return;
  window.__WEB_CLONER_ENGINE_READY__ = true;

  const TOKEN_PREFIX = '__WCLONE_ASSET_';
  const TOKEN_SUFFIX = '__';

  /** Extensões tratadas como fonte (o restante vira imagem/genérico). */
  const FONT_EXT = /\.(woff2?|ttf|otf|eot|sfnt)(\?|#|$)/i;

  /** Padrões de iframes/elementos de publicidade e telemetria que só atrapalham o clone. */
  const AD_PATTERNS = [
    /doubleclick\.net/i, /googlesyndication/i, /googletagmanager/i, /google-analytics/i,
    /googleadservices/i, /adservice\./i, /\/ads?[\/.\-_]/i, /facebook\.com\/(tr|plugins)/i,
    /connect\.facebook\.net/i, /hotjar|mixpanel|segment\.io|amplitude|clarity\.ms/i,
    /taboola|outbrain|criteo|adnxs|pubmatic|rubiconproject/i
  ];

  /** Elementos custom tipicamente injetados por outras extensões do navegador. */
  const EXTENSION_NODE_PATTERNS = [
    /^grammarly-/i, /^lastpass-/i, /^bitwarden-/i, /^honey-/i, /^dashlane-/i,
    /^onepassword-/i, /^loom-/i, /^wappalyzer/i, /^cursor-/i
  ];

  /** Atributos que podem conter uma única URL de asset. */
  const URL_ATTRS = [
    'src', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'data-bg',
    'data-background-image', 'data-image'
  ];

  /** Atributos que contêm listas no formato srcset. */
  const SRCSET_ATTRS = ['srcset', 'data-srcset', 'imagesrcset'];

  // ---------------------------------------------------------------------------
  // Registro de assets (token <-> URL absoluta)
  // ---------------------------------------------------------------------------

  function createAssetRegistry() {
    const byUrl = new Map();
    const tokens = {};
    let seq = 0;

    return {
      tokens,
      /**
       * Converte uma URL (possivelmente relativa) em um token estável.
       * Retorna null quando a URL não deve/não pode ser baixada (data:, blob:, âncoras…).
       */
      tokenize(rawUrl, baseUrl, kindHint) {
        const abs = toAbsolute(rawUrl, baseUrl);
        if (!abs) return null;

        if (byUrl.has(abs)) {
          const existing = byUrl.get(abs);
          // Um mesmo arquivo pode aparecer com papéis diferentes; "font" e "sprite" têm
          // prioridade porque definem a pasta de destino e o tratamento no empacotamento.
          if (kindHint === 'font' || kindHint === 'sprite') tokens[existing].kind = kindHint;
          return existing;
        }

        const token = `${TOKEN_PREFIX}${seq++}${TOKEN_SUFFIX}`;
        byUrl.set(abs, token);
        tokens[token] = { url: abs, kind: kindHint || (FONT_EXT.test(abs) ? 'font' : 'image') };
        return token;
      }
    };
  }

  function toAbsolute(rawUrl, baseUrl) {
    if (!rawUrl) return null;
    const value = String(rawUrl).trim().replace(/^["']|["']$/g, '');
    if (!value) return null;
    // Já embutido no documento ou não é um recurso de rede: nada a baixar.
    if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
    if (value.startsWith(TOKEN_PREFIX)) return null;
    // Recursos de outras extensões nunca existirão no clone offline.
    if (/^(chrome-extension|moz-extension|safari-extension):/i.test(value)) return null;
    try {
      const url = new URL(value, baseUrl || document.baseURI);
      if (!/^https?:$/i.test(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Sincronização de estado dos formulários
  // ---------------------------------------------------------------------------

  /**
   * O outerHTML devolve os atributos ORIGINAIS do HTML, não o estado atual em memória.
   * Um <input> digitado pelo usuário continua serializando sem `value`. Aqui espelhamos
   * as propriedades vivas (value/checked/selected) de volta para atributos no clone.
   */
  function syncFormState(originalEl, cloneEl) {
    const tag = originalEl.tagName;

    if (tag === 'INPUT') {
      const type = (originalEl.type || 'text').toLowerCase();

      if (type === 'checkbox' || type === 'radio') {
        if (originalEl.checked) cloneEl.setAttribute('checked', 'checked');
        else cloneEl.removeAttribute('checked');
        return;
      }
      // Arquivos não podem ser serializados e senhas não devem ser gravadas em disco.
      if (type === 'file' || type === 'password') return;

      if (typeof originalEl.value === 'string') {
        cloneEl.setAttribute('value', originalEl.value);
      }
      return;
    }

    if (tag === 'TEXTAREA') {
      cloneEl.textContent = originalEl.value ?? '';
      return;
    }

    if (tag === 'OPTION') {
      if (originalEl.selected) cloneEl.setAttribute('selected', 'selected');
      else cloneEl.removeAttribute('selected');
      return;
    }

    if (tag === 'DETAILS') {
      if (originalEl.open) cloneEl.setAttribute('open', 'open');
      else cloneEl.removeAttribute('open');
      return;
    }

    if (tag === 'PROGRESS' || tag === 'METER') {
      cloneEl.setAttribute('value', String(originalEl.value));
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Canvas -> <img> com DataURL
  // ---------------------------------------------------------------------------

  /**
   * Um <canvas> serializa vazio: o desenho vive apenas no contexto gráfico.
   * Convertemos o bitmap em DataURL (base64) e trocamos por um <img> equivalente.
   *
   * Atenção ao "tainted canvas": se a página desenhou uma imagem de outra origem sem
   * CORS, toDataURL() lança SecurityError. Nesse caso mantemos o <canvas> original
   * (com as dimensões preservadas) em vez de quebrar a extração.
   */
  function canvasToImage(originalCanvas, cloneCanvas) {
    if (!cloneCanvas.parentNode) return;

    let dataUrl = '';
    try {
      if (originalCanvas.width === 0 || originalCanvas.height === 0) return;
      dataUrl = originalCanvas.toDataURL('image/png');
    } catch {
      cloneCanvas.setAttribute('data-wcloner-canvas', 'tainted-por-cors');
      return;
    }
    if (!dataUrl || dataUrl.length < 32) return;

    const img = document.createElement('img');
    img.setAttribute('src', dataUrl);
    img.setAttribute('alt', originalCanvas.getAttribute('aria-label') || 'canvas clonado');
    img.setAttribute('data-wcloner-from', 'canvas');

    for (const attr of Array.from(cloneCanvas.attributes)) {
      if (attr.name === 'src' || attr.name === 'alt') continue;
      try { img.setAttribute(attr.name, attr.value); } catch { /* atributo inválido */ }
    }

    // Preserva o tamanho renderizado (CSS) para não depender de regras que usem canvas{}.
    const rect = originalCanvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const size = `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;`;
      img.setAttribute('style', `${cloneCanvas.getAttribute('style') || ''};${size}`);
    }

    cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
  }

  // ---------------------------------------------------------------------------
  // 3. Penetração em Shadow DOM
  // ---------------------------------------------------------------------------

  /**
   * cloneNode() NÃO copia shadow roots — Web Components viriam vazios no clone.
   * Estratégia: "achatar" o shadow DOM para dentro da light DOM.
   *
   *  - Clonamos recursivamente o conteúdo do shadowRoot (shadow roots aninhados incluídos).
   *  - Trocamos cada <slot> pelo conteúdo real distribuído (assignedNodes), preservando o fallback.
   *  - Injetamos o resultado num wrapper com `display:contents`, que não interfere no layout.
   *  - Estilos adotados (adoptedStyleSheets) e <style> internos são preservados como <style> inline.
   *
   * Limitação conhecida: shadow roots `closed` são inacessíveis por design do navegador.
   */
  function buildShadowContent(hostOriginal, hostClone, registry, stats) {
    const shadowRoot = hostOriginal.shadowRoot;
    if (!shadowRoot) return false;

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-wcloner-shadow-root', 'open');
    wrapper.setAttribute('style', 'display:contents');

    // (a) Estilos construídos programaticamente (CSSStyleSheet adotada) viram <style>.
    for (const sheet of shadowRoot.adoptedStyleSheets || []) {
      try {
        const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        if (!text.trim()) continue;
        const styleTag = document.createElement('style');
        styleTag.setAttribute('data-wcloner-adopted', 'shadow');
        styleTag.textContent = text;
        wrapper.appendChild(styleTag);
      } catch { /* folha de outra origem: ignorada silenciosamente */ }
    }

    // (b) Cópia do conteúdo do shadow root.
    for (const child of Array.from(shadowRoot.childNodes)) {
      wrapper.appendChild(child.cloneNode(true));
    }

    // (c) Mesmo tratamento (formulários, canvas e shadow roots aninhados) dentro do shadow.
    //     As duas listas são capturadas ANTES de qualquer mutação para manter os índices alinhados.
    const innerOriginals = Array.from(shadowRoot.querySelectorAll('*'));
    const innerClones = Array.from(wrapper.querySelectorAll('*')).filter(
      (el) => !el.hasAttribute('data-wcloner-adopted')
    );
    processElementPairs(innerOriginals, innerClones, registry, stats);

    // (d) Resolução de <slot>: substitui pelo conteúdo distribuído (light DOM do host).
    const lightChildren = Array.from(hostClone.childNodes);
    const usedLightNodes = new Set();

    for (const slot of Array.from(wrapper.querySelectorAll('slot'))) {
      const slotName = slot.getAttribute('name') || '';
      const assigned = lightChildren.filter((node) => {
        if (usedLightNodes.has(node)) return false;
        if (node.nodeType === Node.TEXT_NODE) return slotName === '' && node.textContent.trim() !== '';
        if (node.nodeType !== Node.ELEMENT_NODE) return false;
        return (node.getAttribute('slot') || '') === slotName;
      });

      const replacement = document.createDocumentFragment();
      if (assigned.length) {
        for (const node of assigned) {
          usedLightNodes.add(node);
          replacement.appendChild(node);
        }
      } else {
        // Sem conteúdo distribuído o navegador renderiza o fallback do próprio <slot>.
        while (slot.firstChild) replacement.appendChild(slot.firstChild);
      }
      slot.parentNode.replaceChild(replacement, slot);
    }

    // (e) O host passa a conter apenas o shadow achatado.
    hostClone.textContent = '';
    hostClone.appendChild(wrapper);
    stats.shadowRoots++;
    return true;
  }

  /**
   * Aplica, em um par de listas alinhadas (original x clone), as três transformações que
   * dependem do elemento vivo: estado de formulário, shadow DOM e canvas.
   * É usada tanto na árvore principal quanto recursivamente dentro de cada shadow root.
   */
  function processElementPairs(originals, clones, registry, stats) {
    const total = Math.min(originals.length, clones.length);

    for (let i = 0; i < total; i++) {
      const original = originals[i];
      const clone = clones[i];
      const tag = original.tagName;

      try {
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'OPTION' || tag === 'DETAILS' ||
            tag === 'PROGRESS' || tag === 'METER') {
          syncFormState(original, clone);
          stats.formFields++;
        }
      } catch { /* elemento exótico: ignorado */ }

      try {
        if (original.shadowRoot) buildShadowContent(original, clone, registry, stats);
      } catch { /* Web Component problemático: ignorado */ }

      try {
        if (tag === 'CANVAS') {
          canvasToImage(original, clone);
          stats.canvases++;
        }
      } catch { /* canvas inacessível: ignorado */ }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Limpeza de sujeira
  // ---------------------------------------------------------------------------

  function cleanupClone(cloneRoot, stats) {
    // Scripts nunca devem rodar no clone estático.
    for (const el of Array.from(cloneRoot.querySelectorAll('script'))) {
      el.remove();
      stats.scriptsRemoved++;
    }

    // <base> reescreveria todos os caminhos relativos do arquivo salvo.
    for (const el of Array.from(cloneRoot.querySelectorAll('base'))) el.remove();

    // Preloads/prefetch apontam para recursos que não existirão offline.
    for (const el of Array.from(cloneRoot.querySelectorAll('link'))) {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/(^|\s)(preload|modulepreload|prefetch|prerender|dns-prefetch|preconnect|manifest)(\s|$)/.test(rel)) {
        el.remove();
      }
    }

    // Iframes de anúncio/telemetria e nós injetados por outras extensões.
    for (const el of Array.from(cloneRoot.querySelectorAll('iframe, frame, embed, object'))) {
      const src = el.getAttribute('src') || el.getAttribute('data') || '';
      if (!src || AD_PATTERNS.some((re) => re.test(src))) {
        el.remove();
        stats.adsRemoved++;
      }
    }

    for (const el of Array.from(cloneRoot.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      const isExtensionNode =
        EXTENSION_NODE_PATTERNS.some((re) => re.test(tag)) ||
        /chrome-extension:\/\//i.test(el.getAttribute('src') || el.getAttribute('href') || '');

      if (isExtensionNode) {
        el.remove();
        stats.injectedRemoved++;
        continue;
      }

      // Handlers inline (onclick, onload…) só produziriam erros sem os scripts da página.
      for (const attr of Array.from(el.attributes)) {
        if (/^on[a-z]+$/i.test(attr.name)) el.removeAttribute(attr.name);
        if (attr.name === 'integrity' || attr.name === 'nonce') el.removeAttribute(attr.name);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Coleta de CSS
  // ---------------------------------------------------------------------------

  /**
   * Percorre <style> e <link rel=stylesheet> na ORDEM do documento (a cascata depende disso)
   * e devolve uma lista de pedaços. Links são apenas referenciados: o download acontece no
   * service worker, que não sofre bloqueio de CORS.
   */
  function collectCssParts() {
    const parts = [];

    for (const node of Array.from(document.querySelectorAll('style, link[rel]'))) {
      if (node.tagName === 'STYLE') {
        const text = node.textContent || '';
        if (text.trim()) {
          parts.push({ type: 'text', text, base: document.baseURI, media: node.media || '' });
        }
        continue;
      }

      const rel = (node.getAttribute('rel') || '').toLowerCase();
      if (!/(^|\s)stylesheet(\s|$)/.test(rel)) continue;
      const href = node.href || node.getAttribute('href');
      if (!href) continue;
      parts.push({ type: 'link', url: href, media: node.media || '' });
    }

    // Folhas construídas via CSSOM (document.adoptedStyleSheets) não têm nó no DOM.
    for (const sheet of document.adoptedStyleSheets || []) {
      try {
        const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        if (text.trim()) parts.push({ type: 'text', text, base: document.baseURI, media: '' });
      } catch { /* ignorado silenciosamente */ }
    }

    return parts;
  }

  // ---------------------------------------------------------------------------
  // 6. Tokenização das URLs presentes no HTML
  // ---------------------------------------------------------------------------

  /**
   * Captura url(...) com ou sem aspas. Data URLs são preservadas como estão.
   * `quoteChar` existe porque em atributos style="" usar aspas duplas faria o serializador
   * HTML escapá-las como &quot;; aspas simples mantêm o atributo legível.
   */
  function tokenizeCssUrls(cssText, registry, kindHint, quoteChar = '"') {
    return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, rawUrl) => {
      const token = registry.tokenize(rawUrl, document.baseURI, kindHint);
      return token ? `url(${quoteChar}${token}${quoteChar})` : match;
    });
  }

  function tokenizeSrcset(value, registry) {
    return value
      .split(',')
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return '';
        const spaceIdx = trimmed.search(/\s/);
        const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
        const token = registry.tokenize(url, document.baseURI, 'image');
        return token ? `${token}${descriptor}` : trimmed;
      })
      .filter(Boolean)
      .join(', ');
  }

  /** Tags cujo `src` aponta para conteúdo que não faz sentido empacotar (mídia pesada, frames). */
  const SKIP_SRC_TAGS = new Set(['iframe', 'frame', 'script', 'video', 'audio', 'source', 'track', 'object']);

  function tokenizeHtmlAssets(cloneRoot, registry) {
    for (const el of Array.from(cloneRoot.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();

      // <style> que sobrou no HTML (ex.: dentro de shadow DOM achatado).
      if (tag === 'style') {
        el.textContent = tokenizeCssUrls(el.textContent || '', registry, null);
        continue;
      }

      const skipSrc = SKIP_SRC_TAGS.has(tag);
      for (const attrName of URL_ATTRS) {
        if (skipSrc && attrName === 'src') continue;
        const value = el.getAttribute(attrName);
        if (!value || value.startsWith(TOKEN_PREFIX)) continue;
        const token = registry.tokenize(value, document.baseURI, 'image');
        if (token) el.setAttribute(attrName, token);
      }

      for (const attrName of SRCSET_ATTRS) {
        const value = el.getAttribute(attrName);
        if (!value) continue;
        el.setAttribute(attrName, tokenizeSrcset(value, registry));
      }

      // Ícones (favicon, apple-touch-icon) e outros <link> com href de asset.
      if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (/icon|apple-touch|mask-icon|shortcut/.test(rel)) {
          const token = registry.tokenize(el.getAttribute('href'), document.baseURI, 'image');
          if (token) el.setAttribute('href', token);
        }
      }

      // SVG <use href="sprite.svg#id"> / <image href="…">: mantém o fragmento (#id) intacto.
      // O <use> é marcado como 'sprite' para que o background embuta o arquivo no HTML —
      // navegadores bloqueiam <use> apontando para SVG externo quando o clone roda em file://.
      if (tag === 'use' || tag === 'image') {
        for (const attrName of ['href', 'xlink:href']) {
          const value = el.getAttribute(attrName);
          if (!value || value.startsWith('#') || value.startsWith(TOKEN_PREFIX)) continue;
          const [path, fragment] = value.split('#');
          const token = registry.tokenize(path, document.baseURI, tag === 'use' ? 'sprite' : 'image');
          if (token) el.setAttribute(attrName, fragment ? `${token}#${fragment}` : token);
        }
      }

      // Estilos inline com url(): background-image, mask, border-image…
      const styleAttr = el.getAttribute('style');
      if (styleAttr && /url\(/i.test(styleAttr)) {
        el.setAttribute('style', tokenizeCssUrls(styleAttr, registry, null, "'"));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Orquestração da extração
  // ---------------------------------------------------------------------------

  function extract() {
    const stats = {
      shadowRoots: 0,
      canvases: 0,
      formFields: 0,
      scriptsRemoved: 0,
      adsRemoved: 0,
      injectedRemoved: 0
    };
    const registry = createAssetRegistry();

    const originalRoot = document.documentElement;
    const cloneRoot = originalRoot.cloneNode(true);

    // Listas capturadas ANTES de qualquer mutação: cloneNode preserva a ordem do documento,
    // então original[i] e clone[i] apontam para o mesmo elemento lógico.
    const originals = Array.from(originalRoot.querySelectorAll('*'));
    const clones = Array.from(cloneRoot.querySelectorAll('*'));

    // Passo 1 — formulários, shadow DOM e canvas em uma única varredura pareada.
    processElementPairs(originals, clones, registry, stats);

    // Passo 2 — CSS: coleta as folhas e remove os nós originais do clone.
    const cssParts = collectCssParts();
    for (const node of Array.from(cloneRoot.querySelectorAll('style, link[rel]'))) {
      if (node.tagName === 'STYLE') {
        // <style> herdado de shadow DOM permanece inline (é escopado ao componente achatado).
        if (node.closest('[data-wcloner-shadow-root]')) continue;
        node.remove();
        continue;
      }
      const rel = (node.getAttribute('rel') || '').toLowerCase();
      if (/(^|\s)stylesheet(\s|$)/.test(rel)) node.remove();
    }

    // Passo 3 — limpeza.
    cleanupClone(cloneRoot, stats);

    // Passo 4 — tokenização das URLs restantes no HTML.
    tokenizeHtmlAssets(cloneRoot, registry);

    // Passo 5 — head do arquivo final: charset garantido e link para o styles.css único.
    const head = cloneRoot.querySelector('head') || cloneRoot.insertBefore(
      document.createElement('head'), cloneRoot.firstChild
    );
    if (!head.querySelector('meta[charset]')) {
      const meta = document.createElement('meta');
      meta.setAttribute('charset', 'utf-8');
      head.insertBefore(meta, head.firstChild);
    }
    // Marcador substituído pelo background por <link> apontando para folhas de estilo que
    // não puderam ser baixadas. Fica ANTES do styles.css para que o CSS capturado prevaleça.
    head.appendChild(document.createComment('__WCLONE_FALLBACK_LINKS__'));

    const cssLink = document.createElement('link');
    cssLink.setAttribute('rel', 'stylesheet');
    cssLink.setAttribute('href', './styles.css');
    head.appendChild(cssLink);

    const banner = document.createComment(
      ` Clonado por Web Cloner Avançado\n     Origem: ${location.href}\n     Data:   ${new Date().toISOString()} `
    );
    cloneRoot.insertBefore(banner, cloneRoot.firstChild);

    return {
      html: `<!DOCTYPE html>\n${cloneRoot.outerHTML}`,
      cssParts,
      assets: registry.tokens,
      pageUrl: location.href,
      pageTitle: document.title || location.hostname,
      stats
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'WEB_CLONER_EXTRACT') return undefined;
    try {
      sendResponse({ ok: true, payload: extract() });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
})();
