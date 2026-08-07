# 📄 Product Requirements Document (PRD) - Extensão Chrome "Web Cloner Avançado"

## 1. Visão Geral e Objetivo
O objetivo deste projeto é criar uma extensão avançada para o Google Chrome (utilizando Manifest V3) que permite ao usuário clonar a interface estática de qualquer página web (HTML, CSS, Web Fonts e Assets) da aba atualmente ativa. 

A extensão deve lidar com as complexidades da web moderna (como Shadow DOM, Canvas, estados de formulários e fontes externas), empacotar todos os arquivos capturados em um arquivo `.zip` estruturado e forçar o download localmente para a máquina do usuário. **Neste momento, a extensão funcionará de forma 100% offline/local, sem integração com banco de dados ou painel web.**

---

## 2. Escopo e Funcionalidades Core

### 2.1. Interface (Popup)
- Uma interface em `popup.html` com design moderno e limpo.
- Título da extensão e um botão principal (Call to Action) com o texto: **"Clonar Página Atual"**.
- Um painel de status interativo (ex: "Analisando DOM...", "Baixando Assets...", "Extraindo Fontes...", "Empacotando ZIP...", "Download Concluído") para fornecer feedback visual em tempo real ao usuário durante o processamento.

### 2.2. Motor de Captura Avançado (Content Script)
Ao clicar no botão de clonar, o Content Script deve ser acionado na aba ativa para executar um processo de extração profundo:

- **Extração Avançada de HTML:**
  - Capturar o `document.documentElement.outerHTML` atual, mas com as seguintes transformações prévias:
  - **Sincronização de Estado:** Transferir o estado visual atual dos formulários para os atributos HTML (ex: percorrer inputs e setar `setAttribute('value', input.value)`, `setAttribute('checked', 'checked')` em checkboxes/radios e atualizar tags `<select>`).
  - **Conversão de Canvas:** Localizar todos os elementos `<canvas>` renderizados e substituí-los no HTML clonado por tags `<img>` contendo o `DataURL` (base64) da imagem gerada pelo canvas.
  - **Penetração em Shadow DOM:** Implementar uma função recursiva para ler e extrair o HTML de dentro de elementos com `ShadowRoot` (Web Components), garantindo que não venham vazios.
  - **Limpeza de Sujeira:** Remover tags `<script>`, iframes de anúncios e extensões de terceiros injetadas no DOM para evitar que lixos quebrem a visualização offline.

- **Extração de CSS e Estilos:** 
  - Buscar e consolidar todas as tags `<style>` inline.
  - Buscar todos os links de folhas de estilo externas (`<link rel="stylesheet">`), fazer o `fetch` do conteúdo textual desses arquivos e combiná-los em um único arquivo `styles.css`.

- **Extração de Web Fonts:**
  - Varrer todo o CSS coletado em busca de regras `@font-face` e variáveis com URLs de fontes (`.woff`, `.woff2`, `.ttf`, `.otf`).
  - Fazer o `fetch` dos arquivos de fonte e salvá-los na estrutura do ZIP dentro de `assets/fonts/`.
  - Reescrever as URLs dentro do `styles.css` final para apontar para o caminho relativo local (ex: `url('./assets/fonts/minhafonte.woff2')`).

- **Extração de Assets (Imagens e Ícones):**
  - Mapear tags `<img>`, `<picture>` e propriedades CSS `background-image` para extrair as URLs das imagens.
  - Baixar os arquivos via `fetch` (convertendo para Blob/ArrayBuffer) e organizá-los na pasta `assets/images/`.
  - Atualizar o HTML e o CSS para apontarem para os novos caminhos relativos.
  - **Tratamento de SVGs:** Garantir que SVGs inline sejam mantidos perfeitamente. Para SVGs que usam `<use href="...">` referenciando arquivos externos, tentar fazer o fetch do SVG externo e embuti-lo.

### 2.3. Empacotamento e Download
- Utilizar a biblioteca **JSZip** para criar a seguinte estrutura de diretório na memória:
  - `/index.html` (com o DOM tratado e limpo)
  - `/styles.css` (com todo o CSS e caminhos de fontes/imagens reescritos)
  - `/assets/images/` (imagens mapeadas)
  - `/assets/fonts/` (fontes baixadas)
- Usar a API nativa do Chrome (`chrome.downloads.download`) para baixar o arquivo `.zip` gerado para a máquina do usuário com um nome descritivo (ex: `clone-[nome-do-site]-[timestamp].zip`).

---

## 3. Arquitetura Técnica (Manifest V3)

- **Permissões Necessárias no `manifest.json`:**
  - `activeTab`: Para acessar o conteúdo e o DOM da aba atual.
  - `scripting`: Para injetar e executar o `content.js` programaticamente.
  - `downloads`: Para disparar o download do arquivo `.zip` sem intervenção manual.
  - `host_permissions`: `<all_urls>` (estritamente necessário para contornar problemas ao fazer fetch de CSS, fontes e imagens hospedadas em CDNs externas).
- **Bibliotecas Externas:**
  - `jszip.min.js` (Deve ser importada e incluída localmente na pasta raiz da extensão para uso no processo de empacotamento).

---

## 4. Estrutura de Arquivos Desejada

```text
/
├── manifest.json         # Configuração Manifest V3 e permissões
├── popup.html            # Interface visual do painel da extensão
├── popup.js              # Lógica de UI do popup e comunicação via Chrome Messages
├── popup.css             # Estilização do popup (Tailwind via CDN ou CSS puro bem construído)
├── background.js         # Service worker (para orquestrar downloads e processos em segundo plano)
├── content.js            # Lógica pesada: varredura do DOM, Shadow DOM, Canvas e extração de CSS/Assets
├── libs/
│   └── jszip.min.js      # Dependência para criação do ZIP offline
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 5. Regras de Negócio e Tratamento de Exceções

1. **Fallback de CORS (Cross-Origin Resource Sharing):** A web é estrita. Se o script não conseguir fazer o `fetch` de uma imagem ou fonte externa devido a bloqueios de CORS, a extensão **não deve quebrar**. O erro deve ser ignorado silenciosamente e a URL absoluta original deve ser mantida no HTML/CSS clonado.
2. **Páginas Protegidas da Web Store:** O Chrome impede a injeção de scripts em abas como `chrome://`, `edge://` ou na Chrome Web Store. A extensão deve identificar isso e exibir um aviso amigável no `popup.html` informando que a página não pode ser clonada.
3. **Caminhos Relativos vs Absolutos:** É imperativo que os caminhos das imagens e fontes no HTML e CSS finais sejam reescritos corretamente para refletir a nova estrutura de pastas do `.zip`.

---

## 6. Prompt de Instrução de Código para a IA

> "Aja como um Engenheiro de Software Sênior especialista em Extensões de Chrome.
> Com base neste PRD, gere todos os arquivos da Estrutura de Arquivos acima. 
> 1. Escreva o `manifest.json` V3 completo.
> 2. Crie uma interface moderna no `popup.html` e `popup.js`.
> 3. No `content.js`, implemente obrigatoriamente as funções avançadas solicitadas: transformação de Canvas em DataURL, extração de Shadow DOM, transferência de valores de `inputs` para atributos HTML e extração profunda de `@font-face`.
> 4. Certifique-se de usar `JSZip` para embutir as imagens, fontes, HTML e CSS antes de acionar a `chrome.downloads.download`.
> 5. Para qualquer passo complexo (como bypass de CORS), inclua comentários no código explicando a abordagem adotada.
> Forneça o código completo e indique como devo instalar a extensão localmente para testá-la."
