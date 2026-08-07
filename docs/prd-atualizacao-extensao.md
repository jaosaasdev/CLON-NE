# 📄 Product Requirements Document (PRD) - Atualização: Integração Extensão -> Painel

## 1. Visão Geral e Objetivo
Nesta etapa, vamos atualizar a extensão do Chrome "Web Cloner Avançado" que já foi criada. O objetivo é modificar a ação final do script: em vez de usar a API de Downloads do Chrome para salvar o `.zip` localmente, a extensão deverá enviar o arquivo gerado diretamente para o nosso Painel Web (Next.js) através de uma requisição HTTP POST.

---

## 2. Escopo da Atualização

### 2.1. Remoção do Download Local Obrigatório
- Remover a chamada padrão que utiliza a Chrome Downloads API (`chrome.downloads.download`) como fluxo principal.

### 2.2. Integração com a API (Upload)
- Após o `JSZip` empacotar todos os arquivos capturados e gerar o `.zip` (como `Blob` ou `File`), a extensão deve construir um objeto `FormData`.
- O `FormData` deve conter rigorosamente:
  - `title`: O título da aba/página clonada (extraído via `<title>` ou `document.title`).
  - `url`: A URL da página original clonada.
  - `file`: O arquivo `.zip` binário gerado.
- Executar um `fetch` usando o método `POST` para a rota da API do painel.
- **Configuração de Ambiente:** Centralizar a URL da API em uma constante no topo do script (ex: `const API_URL = 'http://localhost:3000/api/save-clone'`), para que seja extremamente fácil trocar para o domínio real (ex: `https://meupainel.com/api/...`) quando o projeto for para produção.

### 2.3. Atualização da Interface (Popup)
- O feedback visual no painel do popup deve refletir a comunicação com o servidor.
- Novos estados de UI: 
  - "Gerando ZIP..."
  - "Enviando para o Painel..." (com possível spinner/loading).
  - "Sucesso! Site salvo no seu Painel."
- Em caso de sucesso, exibir um botão secundário: **"Abrir Painel"** (que redireciona o usuário para `http://localhost:3000/`).

---

## 3. Alterações Necessárias na Arquitetura

- **Atualização do `manifest.json`:** Adicionar ou confirmar na seção `host_permissions` que a extensão tem permissão explícita para disparar requisições para o domínio da API (ex: `"http://localhost:3000/*"` e futuramente `"https://*.seu-dominio.com/*"`). Sem isso, o Chrome bloqueará o POST por motivos de segurança.

---

## 4. Tratamento de Exceções e Fallback (Plano B)

A comunicação com redes externas está sujeita a falhas, por isso a extensão precisa de um mecanismo de defesa:
1. **Erro de Conexão (API Offline):** Se o `fetch` falhar (ex: painel local não está rodando ou servidor caiu), a extensão não deve apenas "travar". O erro deve ser capturado no `catch`.
2. **Erros do Backend:** Se a API retornar um status de erro (ex: `500 Internal Server Error`), a promessa do fetch deve validar o `response.ok`.
3. **Botão de Fallback (Download de Emergência):** Caso ocorra qualquer falha no envio para o painel, a UI do popup deve mudar para um estado de erro, exibir a mensagem adequada (ex: "Falha ao enviar para o painel") e mostrar um botão de emergência: **"Baixar ZIP Manualmente"**. Esse botão utilizará o arquivo que já está na memória e acionará o download local que havíamos feito no PRD anterior. Assim, o usuário nunca perde o trabalho feito.

---

## 5. Prompt de Instrução de Código para a IA

> "Aja como um Engenheiro de Software Sênior especialista em Extensões Chrome. 
> 
> No projeto atual da extensão que criamos, preciso alterar a etapa final do processo. Vamos integrar a extensão ao nosso novo Painel Web.
> 
> O que você deve fazer:
> 1. Modifique a etapa onde o JSZip gera o arquivo: em vez de acionar imediatamente a `chrome.downloads.download`, pegue o arquivo gerado (Blob) e monte um `FormData`.
> 2. Este `FormData` deve conter os campos: `title` (document.title), `url` (window.location.href) e `file` (o Blob do zip).
> 3. Crie uma constante `API_URL = 'http://localhost:3000/api/save-clone'` no topo do script pertinente e faça um `POST` usando `fetch` enviando o FormData para ela.
> 4. Atualize a UI do `popup.html` e `popup.js` para mostrar os status 'Empacotando...' -> 'Enviando para o Painel...' -> 'Sucesso!'. Mostre um botão 'Abrir Painel' caso dê tudo certo.
> 5. **Obrigatório - Fallback de Erro:** Se o `fetch` falhar por erro de rede ou retornar status de erro (ex: API offline), mostre um aviso de erro na UI do popup e um botão 'Baixar ZIP Manualmente'. Este botão deve acionar a antiga função de download local, salvando o arquivo na máquina do usuário.
> 6. Atualize o `manifest.json` com as `host_permissions` necessárias para acessar o localhost.
> 
> Mostre-me exatamente quais arquivos eu preciso modificar e forneça o código completo e atualizado de cada um deles."
