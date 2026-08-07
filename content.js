/**
 * content.js — Motor de captura (página viva).
 *
 * Melhorias v1.2:
 *  - Hidrata lazy-load (scroll + data-src → src) antes de clonar
 *  - Captura vídeo/áudio/source, meta og:image, Lottie/JSON e backgrounds computados
 *  - Descobre links internos (mesmo domínio) para o crawler multi-página
 */

(() => {
  'use strict';

  if (window.__WEB_CLONER_ENGINE_READY__) return;
  window.__WEB_CLONER_ENGINE_READY__ = true;

  const TOKEN_PREFIX = '__WCLONE_ASSET_';
  const FONT_EXT = /\.(woff2?|ttf|otf|eot|sfnt)(\?|#|$)/i;
  const MEDIA_EXT = /\.(mp4|webm|ogg|mp3|wav|m4a|mov)(\?|#|$)/i;
  const JSON_EXT = /\.json(\?|#|$)/i;
  const ASSET_FILE_EXT = /\.(pdf|zip|rar|7z|exe|dmg|apk|docx?|xlsx?|pptx?)(\?|#|$)/i;

  const AD_PATTERNS = [
    /doubleclick\.net/i, /googlesyndication/i, /googletagmanager/i, /google-analytics/i,
    /googleadservices/i, /adservice\./i, /\/ads?[\/.\-_]/i, /facebook\.com\/(tr|plugins)/i,
    /connect\.facebook\.net/i, /hotjar|mixpanel|segment\.io|amplitude|clarity\.ms/i,
    /taboola|outbrain|criteo|adnxs|pubmatic|rubiconproject/i
  ];

  const EXTENSION_NODE_PATTERNS = [
    /^grammarly-/i, /^lastpass-/i, /^bitwarden-/i, /^honey-/i, /^dashlane-/i,
    /^onepassword-/i, /^loom-/i, /^wappalyzer/i, /^cursor-/i
  ];

  const URL_ATTRS = [
    'src', 'poster', 'href', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy',
    'data-bg', 'data-background', 'data-background-image', 'data-image', 'data-url',
    'data-thumb', 'data-large_image', 'data-src-retina', 'data-lazy-srcset'
  ];

  const SRCSET_ATTRS = ['srcset', 'data-srcset', 'imagesrcset'];

  const SKIP_HREF_TAGS = new Set(['a', 'base']);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createAssetRegistry() {
    const byUrl = new Map();
    const tokens = {};
    let seq = 0;

    return {
      tokens,
      tokenize(rawUrl, baseUrl, kindHint) {
        const abs = toAbsolute(rawUrl, baseUrl);
        if (!abs) return null;

        if (byUrl.has(abs)) {
          const existing = byUrl.get(abs);
          const info = tokens[existing];
          if (kindHint === 'font' || kindHint === 'sprite' || kindHint === 'media') {
            info.kind = kindHint;
          }
          return existing;
        }

        const token = `${TOKEN_PREFIX}${seq++}__`;
        byUrl.set(abs, token);
        let kind = kindHint;
        if (!kind) {
          if (FONT_EXT.test(abs)) kind = 'font';
          else if (MEDIA_EXT.test(abs)) kind = 'media';
          else if (JSON_EXT.test(abs)) kind = 'image';
          else kind = 'image';
        }
        tokens[token] = { url: abs, kind };
        return token;
      }
    };
  }

  function toAbsolute(rawUrl, baseUrl) {
    if (!rawUrl) return null;
    const value = String(rawUrl).trim().replace(/^["']|["']$/g, '');
    if (!value) return null;
    if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
    if (value.startsWith(TOKEN_PREFIX)) return null;
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
  // Preparação: lazy-load + scroll
  // ---------------------------------------------------------------------------

  function promoteLazyAttributes() {
    const pairs = [
      ['data-src', 'src'],
      ['data-lazy-src', 'src'],
      ['data-original', 'src'],
      ['data-lazy', 'src'],
      ['data-bg', null],
      ['data-background', null],
      ['data-background-image', null]
    ];

    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const [from, to] of pairs) {
        const value = el.getAttribute(from);
        if (!value || value.startsWith('data:')) continue;

        if (to) {
          if (!el.getAttribute(to) || /placeholder|spacer|blank|data:image\/svg/i.test(el.getAttribute(to) || '')) {
            el.setAttribute(to, value);
          }
        } else {
          const style = el.getAttribute('style') || '';
          if (!/background(-image)?\s*:/i.test(style)) {
            el.setAttribute('style', `${style};background-image:url("${value}")`);
          }
        }
      }

      const lazySrcset = el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset');
      if (lazySrcset && !el.getAttribute('srcset')) {
        el.setAttribute('srcset', lazySrcset);
      }

      if (el.tagName === 'SOURCE') {
        const ds = el.getAttribute('data-src');
        if (ds && !el.getAttribute('src')) el.setAttribute('src', ds);
      }
    }
  }

  async function scrollPageForLazyLoad() {
    const height = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      window.innerHeight
    );
    const step = Math.max(Math.floor(window.innerHeight * 0.7), 400);
    for (let y = 0; y < height + step; y += step) {
      window.scrollTo(0, y);
      await sleep(120);
    }
    window.scrollTo(0, 0);
    await sleep(250);
  }

  async function waitForMedia() {
    const images = Array.from(document.images || []);
    await Promise.allSettled(
      images.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) return resolve();
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 2500);
          })
      )
    );
  }

  async function preparePage() {
    promoteLazyAttributes();
    await scrollPageForLazyLoad();
    promoteLazyAttributes();
    await waitForMedia();
  }

  // ---------------------------------------------------------------------------
  // Links internos (crawler)
  // ---------------------------------------------------------------------------

  function normalizePageUrl(href) {
    try {
      const url = new URL(href, document.baseURI);
      if (!/^https?:$/i.test(url.protocol)) return null;
      url.hash = '';
      // Remove index.html redundante no fim para deduplicar
      if (/\/index\.html?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function collectInternalLinks() {
    const origin = location.origin;
    const found = new Set();

    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const abs = normalizePageUrl(a.href);
      if (!abs) continue;
      try {
        const url = new URL(abs);
        if (url.origin !== origin) continue;
        if (ASSET_FILE_EXT.test(url.pathname)) continue;
        if (MEDIA_EXT.test(url.pathname) || FONT_EXT.test(url.pathname)) continue;
        if (/\.(css|js|mjs|map|xml|txt|json)(\?|$)/i.test(url.pathname)) continue;
        found.add(abs);
      } catch { /* ignore */ }
    }

    // Também considera a própria URL
    const selfUrl = normalizePageUrl(location.href);
    if (selfUrl) found.add(selfUrl);

    return Array.from(found);
  }

  // ---------------------------------------------------------------------------
  // Estado de formulários / canvas / shadow
  // ---------------------------------------------------------------------------

  function syncFormState(originalEl, cloneEl) {
    const tag = originalEl.tagName;

    if (tag === 'INPUT') {
      const type = (originalEl.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (originalEl.checked) cloneEl.setAttribute('checked', 'checked');
        else cloneEl.removeAttribute('checked');
        return;
      }
      if (type === 'file' || type === 'password') return;
      if (typeof originalEl.value === 'string') cloneEl.setAttribute('value', originalEl.value);
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
      try { img.setAttribute(attr.name, attr.value); } catch { /* ignore */ }
    }

    const rect = originalCanvas.getBoundingClientRect();
    if (rect.width && rect.height) {
      const size = `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;`;
      img.setAttribute('style', `${cloneCanvas.getAttribute('style') || ''};${size}`);
    }

    cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
  }

  function buildShadowContent(hostOriginal, hostClone, registry, stats) {
    const shadowRoot = hostOriginal.shadowRoot;
    if (!shadowRoot) return false;

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-wcloner-shadow-root', 'open');
    wrapper.setAttribute('style', 'display:contents');

    for (const sheet of shadowRoot.adoptedStyleSheets || []) {
      try {
        const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        if (!text.trim()) continue;
        const styleTag = document.createElement('style');
        styleTag.setAttribute('data-wcloner-adopted', 'shadow');
        styleTag.textContent = text;
        wrapper.appendChild(styleTag);
      } catch { /* ignore */ }
    }

    for (const child of Array.from(shadowRoot.childNodes)) {
      wrapper.appendChild(child.cloneNode(true));
    }

    const innerOriginals = Array.from(shadowRoot.querySelectorAll('*'));
    const innerClones = Array.from(wrapper.querySelectorAll('*')).filter(
      (el) => !el.hasAttribute('data-wcloner-adopted')
    );
    processElementPairs(innerOriginals, innerClones, registry, stats);

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
        while (slot.firstChild) replacement.appendChild(slot.firstChild);
      }
      slot.parentNode.replaceChild(replacement, slot);
    }

    hostClone.textContent = '';
    hostClone.appendChild(wrapper);
    stats.shadowRoots++;
    return true;
  }

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
      } catch { /* ignore */ }

      try {
        if (original.shadowRoot) buildShadowContent(original, clone, registry, stats);
      } catch { /* ignore */ }

      try {
        if (tag === 'CANVAS') {
          canvasToImage(original, clone);
          stats.canvases++;
        }
      } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Limpeza / CSS
  // ---------------------------------------------------------------------------

  function cleanupClone(cloneRoot, stats) {
    for (const el of Array.from(cloneRoot.querySelectorAll('script'))) {
      el.remove();
      stats.scriptsRemoved++;
    }

    for (const el of Array.from(cloneRoot.querySelectorAll('base'))) el.remove();

    for (const el of Array.from(cloneRoot.querySelectorAll('link'))) {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/(^|\s)(preload|modulepreload|prefetch|prerender|dns-prefetch|preconnect|manifest)(\s|$)/.test(rel)) {
        el.remove();
      }
    }

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

      for (const attr of Array.from(el.attributes)) {
        if (/^on[a-z]+$/i.test(attr.name)) el.removeAttribute(attr.name);
        if (attr.name === 'integrity' || attr.name === 'nonce') el.removeAttribute(attr.name);
      }
    }
  }

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

    for (const sheet of document.adoptedStyleSheets || []) {
      try {
        const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        if (text.trim()) parts.push({ type: 'text', text, base: document.baseURI, media: '' });
      } catch { /* ignore */ }
    }

    // Folhas acessíveis via CSSOM (mesmo cross-origin bloqueado → try/catch)
    for (const sheet of Array.from(document.styleSheets || [])) {
      try {
        if (!sheet.cssRules) continue;
        const owner = sheet.ownerNode;
        if (owner && (owner.tagName === 'STYLE' || owner.tagName === 'LINK')) continue;
        const text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n');
        if (text.trim()) {
          parts.push({ type: 'text', text, base: sheet.href || document.baseURI, media: sheet.media?.mediaText || '' });
        }
      } catch { /* CORS na CSSOM: ignorado */ }
    }

    return parts;
  }

  // ---------------------------------------------------------------------------
  // Tokenização
  // ---------------------------------------------------------------------------

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

  function guessKindFromUrl(url) {
    if (FONT_EXT.test(url)) return 'font';
    if (MEDIA_EXT.test(url)) return 'media';
    return 'image';
  }

  function captureComputedBackgrounds(originals, clones, registry, stats) {
    const total = Math.min(originals.length, clones.length);
    for (let i = 0; i < total; i++) {
      try {
        const bg = getComputedStyle(originals[i]).backgroundImage;
        if (!bg || bg === 'none' || !/url\(/i.test(bg)) continue;
        const tokenized = tokenizeCssUrls(bg, registry, 'image', "'");
        if (tokenized === bg) continue;
        const existing = clones[i].getAttribute('style') || '';
        if (/background-image\s*:/i.test(existing)) continue;
        clones[i].setAttribute('style', `${existing};background-image:${tokenized}`.replace(/^;/, ''));
        stats.computedBackgrounds++;
      } catch { /* ignore */ }
    }
  }

  function tokenizeHtmlAssets(cloneRoot, registry) {
    // Meta images (Open Graph / Twitter)
    for (const meta of Array.from(cloneRoot.querySelectorAll('meta[content]'))) {
      const prop = `${meta.getAttribute('property') || ''} ${meta.getAttribute('name') || ''}`.toLowerCase();
      if (!/(og:image|twitter:image|msapplication-tileimage)/.test(prop)) continue;
      const token = registry.tokenize(meta.getAttribute('content'), document.baseURI, 'image');
      if (token) meta.setAttribute('content', token);
    }

    for (const el of Array.from(cloneRoot.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'style') {
        el.textContent = tokenizeCssUrls(el.textContent || '', registry, null);
        continue;
      }

      for (const attrName of URL_ATTRS) {
        if (attrName === 'href' && SKIP_HREF_TAGS.has(tag)) continue;
        const value = el.getAttribute(attrName);
        if (!value || value.startsWith(TOKEN_PREFIX) || value.startsWith('#')) continue;

        // Em <a>, só tokeniza se parecer arquivo de asset (não página HTML).
        if (tag === 'a' && attrName === 'href') continue;

        const kind = guessKindFromUrl(value);
        const token = registry.tokenize(value, document.baseURI, kind);
        if (token) el.setAttribute(attrName, token);
      }

      for (const attrName of SRCSET_ATTRS) {
        const value = el.getAttribute(attrName);
        if (!value) continue;
        el.setAttribute(attrName, tokenizeSrcset(value, registry));
      }

      if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (/icon|apple-touch|mask-icon|shortcut|image_src/.test(rel)) {
          const token = registry.tokenize(el.getAttribute('href'), document.baseURI, 'image');
          if (token) el.setAttribute('href', token);
        }
      }

      if (tag === 'use' || tag === 'image') {
        for (const attrName of ['href', 'xlink:href']) {
          const value = el.getAttribute(attrName);
          if (!value || value.startsWith('#') || value.startsWith(TOKEN_PREFIX)) continue;
          const [path, fragment] = value.split('#');
          const token = registry.tokenize(path, document.baseURI, tag === 'use' ? 'sprite' : 'image');
          if (token) el.setAttribute(attrName, fragment ? `${token}#${fragment}` : token);
        }
      }

      // video / audio / source
      if (tag === 'video' || tag === 'audio' || tag === 'source') {
        for (const attrName of ['src', 'poster']) {
          const value = el.getAttribute(attrName);
          if (!value) continue;
          const kind = attrName === 'poster' ? 'image' : guessKindFromUrl(value);
          const token = registry.tokenize(value, document.baseURI, kind);
          if (token) el.setAttribute(attrName, token);
        }
      }

      const styleAttr = el.getAttribute('style');
      if (styleAttr && /url\(/i.test(styleAttr)) {
        el.setAttribute('style', tokenizeCssUrls(styleAttr, registry, null, "'"));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Extração
  // ---------------------------------------------------------------------------

  async function extract() {
    await preparePage();

    const stats = {
      shadowRoots: 0,
      canvases: 0,
      formFields: 0,
      scriptsRemoved: 0,
      adsRemoved: 0,
      injectedRemoved: 0,
      computedBackgrounds: 0
    };
    const registry = createAssetRegistry();

    const originalRoot = document.documentElement;
    const cloneRoot = originalRoot.cloneNode(true);

    const originals = Array.from(originalRoot.querySelectorAll('*'));
    const clones = Array.from(cloneRoot.querySelectorAll('*'));

    processElementPairs(originals, clones, registry, stats);
    captureComputedBackgrounds(originals, clones, registry, stats);

    const cssParts = collectCssParts();
    for (const node of Array.from(cloneRoot.querySelectorAll('style, link[rel]'))) {
      if (node.tagName === 'STYLE') {
        if (node.closest('[data-wcloner-shadow-root]')) continue;
        node.remove();
        continue;
      }
      const rel = (node.getAttribute('rel') || '').toLowerCase();
      if (/(^|\s)stylesheet(\s|$)/.test(rel)) node.remove();
    }

    cleanupClone(cloneRoot, stats);
    tokenizeHtmlAssets(cloneRoot, registry);

    const head = cloneRoot.querySelector('head') || cloneRoot.insertBefore(
      document.createElement('head'),
      cloneRoot.firstChild
    );
    if (!head.querySelector('meta[charset]')) {
      const meta = document.createElement('meta');
      meta.setAttribute('charset', 'utf-8');
      head.insertBefore(meta, head.firstChild);
    }
    head.appendChild(document.createComment('__WCLONE_FALLBACK_LINKS__'));

    // Placeholder: o background reescreve para o caminho relativo correto (./ ou ../)
    const cssLink = document.createElement('link');
    cssLink.setAttribute('rel', 'stylesheet');
    cssLink.setAttribute('href', '__WCLONE_STYLES_HREF__');
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
      internalLinks: collectInternalLinks(),
      stats
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'WEB_CLONER_EXTRACT') return undefined;

    extract()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

    return true;
  });
})();
