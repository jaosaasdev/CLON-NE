/* Prepara o DOM de teste e injeta um stub mínimo da API chrome.* antes do content.js. */

(() => {
  // --- estado "vivo" que só existe em memória (é isso que o clonador precisa capturar) ---
  document.getElementById('texto').value = 'valor digitado pelo usuario';
  document.getElementById('senha').value = 'segredo-que-nao-deve-vazar';
  document.getElementById('check').checked = true;
  document.getElementById('area').value = 'texto do textarea';
  document.getElementById('select').value = 'b';

  const ctx = document.getElementById('canvas').getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 40, 20);

  // --- Web Component com shadow DOM aberto, <slot> e estilo interno ---
  class MyCard extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>.card { background: url("shadow/bg.png"); }</style>
        <div class="card">
          <h2><slot name="titulo">fallback do slot</slot></h2>
          <p id="dentro-do-shadow">conteudo interno do shadow dom</p>
          <input id="shadow-input" type="text" />
        </div>
      `;
      root.getElementById('shadow-input').value = 'valor dentro do shadow';
    }
  }
  customElements.define('my-card', MyCard);

  // --- stub da API chrome usada pelo content.js e pelo background.js ---
  const listeners = [];
  window.__wclonerListeners = listeners;

  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => Promise.resolve(),
      getPlatformInfo: () => Promise.resolve({ os: 'win' })
    },
    storage: { session: { set: () => Promise.resolve() } },
    downloads: { onChanged: { addListener: () => {} } },
    tabs: {},
    scripting: {},
    offscreen: {}
  };

  // background.js usa importScripts (service worker); no navegador o JSZip vem por <script>.
  window.importScripts = () => {};
})();
