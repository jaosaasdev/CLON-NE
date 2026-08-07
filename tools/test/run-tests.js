/* Executa o pipeline real (content.js + background.js) contra o DOM de fixture. */

(async () => {
  const results = [];

  function check(name, condition, detail) {
    results.push({ name, ok: Boolean(condition), detail: condition ? '' : String(detail ?? '') });
  }

  try {
    // ---------------------------------------------------------------- extração
    const extractListener = window.__wclonerListeners[0];
    const extraction = await new Promise((resolve) => {
      extractListener({ type: 'WEB_CLONER_EXTRACT' }, null, resolve);
    });

    check('extração retorna ok', extraction.ok, extraction.error);
    const payload = extraction.payload;
    const html = payload.html;

    // ------------------------------------------------- estado dos formulários
    check('input.value virou atributo', /id="texto"[^>]*value="valor digitado pelo usuario"/.test(html), html.match(/<input id="texto"[^>]*>/));
    check('senha NÃO é serializada', !html.includes('segredo-que-nao-deve-vazar'));
    check('checkbox marcado', /id="check"[^>]*checked/.test(html));
    check('textarea recebeu o valor', />texto do textarea</.test(html));
    check('option selecionada', /value="b" selected/.test(html) || /selected[^>]*>B</.test(html));

    // ------------------------------------------------------------------ canvas
    check('canvas virou <img> com DataURL', /<img[^>]+data-wcloner-from="canvas"/.test(html) && html.includes('src="data:image/png;base64,'));
    check('canvas original removido', !/<canvas/i.test(html));

    // -------------------------------------------------------------- shadow DOM
    check('conteúdo do shadow DOM presente', html.includes('conteudo interno do shadow dom'));
    check('wrapper de shadow root criado', html.includes('data-wcloner-shadow-root="open"'));
    check('slot resolvido com a light DOM', html.includes('Título vindo da light DOM'));
    check('fallback do slot descartado', !html.includes('fallback do slot'));
    check('input dentro do shadow sincronizado', /id="shadow-input"[^>]*value="valor dentro do shadow"/.test(html));
    check('shadow roots contabilizados', payload.stats.shadowRoots === 1, payload.stats.shadowRoots);

    // ----------------------------------------------------------------- limpeza
    check('scripts removidos', !/<script/i.test(html));
    check('iframe de anúncio removido', !html.includes('doubleclick.net'));
    check('nó de extensão removido', !html.includes('grammarly-extension'));
    check('link preload removido', !html.includes('nao-deve-sobreviver.js'));
    check('<base> ausente', !/<base\b/i.test(html));

    // --------------------------------------------------------------------- CSS
    check('folhas coletadas (inline + externa)', payload.cssParts.length >= 2, payload.cssParts.length);
    check('<style> original removido do HTML', !/<style/i.test(html) || html.includes('data-wcloner-shadow-root'));
    check('link para styles.css inserido', html.includes('href="./styles.css"'));
    check('marcador de fallback presente', html.includes('__WCLONE_FALLBACK_LINKS__'));

    // ------------------------------------------------------------------ tokens
    const tokenValues = Object.values(payload.assets).map((a) => a.url);
    check('img src tokenizado', /id="logo"[^>]*src="__WCLONE_ASSET_\d+__"/.test(html));
    check('srcset tokenizado', /srcset="__WCLONE_ASSET_\d+__ 1x, __WCLONE_ASSET_\d+__ 2x"/.test(html));
    check('style inline tokenizado', /id="bg"[^>]*url\('__WCLONE_ASSET_\d+__'\)/.test(html), html.match(/id="bg"[^>]*>/));
    check('URLs absolutizadas', tokenValues.every((u) => u.startsWith('http')), tokenValues.slice(0, 3));
    check('logo.png mapeado', tokenValues.some((u) => u.endsWith('/img/logo.png')), tokenValues);
    check('url() de shadow <style> tokenizado', tokenValues.some((u) => u.endsWith('/shadow/bg.png')), tokenValues);

    // ------------------------------------------------ pipeline do background.js
    const warnings = [];
    const fallbackSheets = new Map();
    const report = {
      warn: (t) => warnings.push(t),
      fallbackStylesheet: (url, media) => fallbackSheets.set(url, media || '')
    };

    const registry = createRegistry(payload.assets);
    let css = await buildStylesheet(payload.cssParts, registry, report);

    check('@charset removido do CSS consolidado', !css.includes('@charset'));
    check('CSS externo foi baixado e consolidado', css.includes('.externa'), css.slice(0, 200));

    const registered = Array.from(registry.tokens.values());
    const fontUrls = registered.filter((a) => a.kind === 'font').map((a) => a.url);
    check('@font-face .woff2 detectado', fontUrls.some((u) => u.endsWith('/fonts/fixture.woff2')), fontUrls);
    check('@font-face .woff detectado', fontUrls.some((u) => u.endsWith('/fonts/fixture.woff')), fontUrls);
    check('fonte em variável CSS detectada', fontUrls.some((u) => u.endsWith('/static/icone.ttf')), fontUrls);
    check('fonte da folha externa detectada', fontUrls.some((u) => u.endsWith('/assets/externa.woff2')), fontUrls);

    const allUrls = registered.map((a) => a.url);
    check(
      'url() relativa resolvida contra o .css (não contra o documento)',
      allUrls.some((u) => u.endsWith('/tools/test/img/logo.png')),
      allUrls
    );
    check('sem token vazando como URL', !allUrls.some((u) => u.includes('__WCLONE_')), allUrls);

    // ------------------------------------------------------- download de assets
    const zip = new JSZip();
    const { resolved, okCount, failCount, sprites } = await downloadAssets(registry, zip, report, () => {});

    check('asset existente baixado', okCount >= 1, `ok=${okCount} fail=${failCount}`);
    check('assets inexistentes não quebraram', failCount >= 1, `ok=${okCount} fail=${failCount}`);

    let finalHtml = replaceTokens(payload.html, resolved, { escapeHtml: true });
    const finalCss = replaceTokens(css, resolved, { escapeHtml: false });

    // ------------------------------------------------------------ sprite SVG
    check('sprite SVG capturado como texto', sprites.size === 1, Array.from(sprites.keys()));
    finalHtml = inlineSvgSprites(finalHtml, sprites);
    check('símbolo do sprite embutido no HTML', finalHtml.includes('id="icone-estrela"'));
    check('<use> agora referencia fragmento local', /<use href="#icone-estrela"/.test(finalHtml), finalHtml.match(/<use [^>]*>/g));
    check('sprite também salvo no ZIP', Object.keys(zip.files).some((f) => f.endsWith('sprite.svg')), Object.keys(zip.files));

    check('nenhum token restou no HTML', !finalHtml.includes('__WCLONE_ASSET_') && !finalHtml.includes('__WCLONE_CSSASSET_'), finalHtml.match(/__WCLONE_\w+/g));
    check('nenhum token restou no CSS', !finalCss.includes('__WCLONE_'), finalCss.match(/__WCLONE_\w+/g));
    check('caminho relativo aplicado no HTML', /src="\.\/assets\/images\/logo\.png"/.test(finalHtml), finalHtml.match(/src="[^"]*logo[^"]*"/g));
    check(
      'fallback de CORS manteve a URL absoluta',
      finalCss.includes('https://cdn.invalido.exemplo/nao-existe.png'),
      'URL remota deveria ter sido preservada'
    );
    check('ZIP recebeu assets/images', Object.keys(zip.files).some((f) => f.startsWith('assets/images/')), Object.keys(zip.files));

    // ------------------------------------------------------- utilitários finais
    const used = new Set();
    check('nome por MIME quando não há extensão', buildFileName('https://x.com/a/imagem', 'image/webp', 'image', used) === 'imagem.webp');
    check('deduplicação de nomes', buildFileName('https://y.com/b/imagem.webp', 'image/webp', 'image', used) === 'imagem-2.webp');
    check('nome de fonte preservado', buildFileName('https://f.com/s/Inter.woff2?v=3', '', 'font', new Set()) === 'Inter.woff2');
    check('nome do zip', /^clone-exemplo\.com-\d{8}-\d{6}\.zip$/.test(buildZipFileName('https://www.exemplo.com/p?x=1')), buildZipFileName('https://www.exemplo.com/p?x=1'));

    // ---------------------------------------------------------- zip real gerado
    zip.file('index.html', finalHtml);
    zip.file('styles.css', finalCss);
    const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
    check('ZIP gerado em base64', base64.length > 500 && base64.startsWith('UEsD'), base64.slice(0, 12));

    if (fallbackSheets.size) results.push({ name: `info: ${fallbackSheets.size} folha(s) em fallback`, ok: true, detail: '' });
  } catch (error) {
    results.push({ name: 'exceção inesperada', ok: false, detail: `${error?.message}\n${error?.stack}` });
  }

  const failed = results.filter((r) => !r.ok);
  const text = results
    .map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        -> ${r.detail}` : ''}`)
    .join('\n');
  const summary = `\n${results.length - failed.length}/${results.length} testes passaram.`;

  document.getElementById('out').textContent = text + summary;

  // Devolve o resultado para o servidor de testes em Python.
  try {
    await fetch('/__result', { method: 'POST', body: text + summary });
  } catch { /* execução manual no navegador */ }
})();
