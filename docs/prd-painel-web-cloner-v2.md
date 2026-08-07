# 📄 Product Requirements Document (PRD) - Painel Web "Web Cloner Dashboard"

## 1. Visão Geral e Objetivo
O objetivo deste projeto é criar um Painel Web (SaaS Dashboard) para complementar a extensão "Web Cloner". Em vez de baixar os arquivos `.zip` diretamente para a máquina do usuário, a extensão enviará os dados para este sistema.
O painel servirá como um repositório centralizado onde o usuário poderá visualizar todos os sites que já clonou (em formato de cards), fazer o download dos sites clonados sob demanda, e **também baixar o arquivo de instalação da própria extensão do Chrome** para nunca perdê-la.

---

## 2. Stack Tecnológico e Arquitetura

- **Frontend:** Next.js (usando o App Router `app/`), React.
- **Estilização:** Tailwind CSS (para um design rápido, moderno e responsivo).
- **Backend & Banco de Dados:** Supabase (PostgreSQL para dados estruturados e Storage para salvar os arquivos `.zip` dos sites).
- **Hospedagem de Estáticos:** A própria pasta `public/` do Next.js servirá o arquivo `.zip` da extensão.
- **Ícones (Opcional):** `lucide-react` para os ícones dos cards e botões.

---

## 3. Estrutura do Supabase (Banco e Storage)

A IA (Cursor) deverá gerar as instruções ou o código SQL para que o usuário configure o Supabase da seguinte forma:

### 3.1. Banco de Dados (Tabela: `clones`)
- `id` (uuid, chave primária, gerado automaticamente)
- `title` (text) - O título da página clonada (tag `<title>`).
- `original_url` (text) - A URL do site que foi clonado.
- `storage_path` (text) - O caminho do arquivo `.zip` salvo no Supabase Storage.
- `created_at` (timestamp, gerado automaticamente com `now()`).

### 3.2. Storage (Bucket: `cloned-files`)
- Um bucket público (ou configurado com políticas de acesso, RLS) para armazenar os arquivos `.zip` recebidos pela API.

---

## 4. Escopo e Funcionalidades Core

### 4.1. Rota de API (Backend - `/api/save-clone`)
- **Método:** `POST`
- **Função:** Receber uma requisição `FormData` vinda da extensão do Chrome.
- **Payload Esperado:** `title` (string), `url` (string), e `file` (o arquivo .zip binário do site clonado).
- **Fluxo de Execução:**
  1. Receber o arquivo e fazer o upload para o bucket `cloned-files` no Supabase Storage (gerando um nome de arquivo único, ex: `timestamp-nomedosite.zip`).
  2. Pegar o caminho do arquivo retornado pelo Storage.
  3. Inserir uma nova linha na tabela `clones` no banco de dados contendo o `title`, `url` e `storage_path`.
  4. Retornar um JSON de sucesso (`{ success: true }`) ou erro com o devido status HTTP.

### 4.2. Interface do Painel (Frontend - `/`)
- **Layout e Header:** Uma barra superior (Navbar) limpa, contendo o logo/nome do painel de um lado e um **botão de Call to Action (ex: "Baixar Extensão")** do outro. Ao clicar neste botão, o usuário deve baixar o `.zip` da própria extensão (hospedado localmente no projeto).
- **Listagem (Grid):** A página principal (Server Component ou Client Component com `useEffect`) deve buscar todos os registros da tabela `clones` ordenados por data de criação (mais recentes primeiro).
- **Design do Card:** Cada site clonado deve ser renderizado como um card contendo:
  - Título do site (truncado se for muito grande).
  - A URL original (como um link clicável).
  - A data em que foi clonado (formatada de forma amigável, ex: "Há 2 horas" ou "15/10/2026").
  - Um botão primário: **"Baixar Arquivos (.zip)"**.

### 4.3. Lógica de Downloads
- **Download do Clone:** Ao clicar no botão de download de um card, o frontend deve se comunicar com o Supabase Storage utilizando o `storage_path` vinculado àquele registro e forçar o download.
- **Download da Extensão:** O botão na Navbar apontará simplesmente para `/web-cloner-extension.zip` na pasta estática.

---

## 5. Estrutura de Arquivos Desejada (Next.js App Router)

```text
/
├── app/
│   ├── layout.tsx            # Estrutura global do HTML e NavBar com o botão "Baixar Extensão"
│   ├── page.tsx              # Página principal (Grid de Cards)
│   ├── api/
│   │   └── save-clone/
│   │       └── route.ts      # Rota POST para receber o ZIP dos sites clonados
├── components/
│   └── CloneCard.tsx         # Componente isolado para o design do card
├── lib/
│   └── supabase.ts           # Cliente de inicialização do Supabase
├── public/
│   └── web-cloner-extension.zip # ARQUIVO ESTÁTICO: A extensão zipada pronta para instalar
├── .env.local                # Variáveis de ambiente (URL e Key do Supabase)
├── tailwind.config.js
└── package.json
```

---

## 6. Tratamento de Exceções e Casos de Borda

1. **Uploads Grandes:** A rota de API deve estar preparada para lidar com arquivos `.zip` que podem ter alguns megabytes de tamanho. O limite padrão de upload do Next.js deve ser considerado.
2. **Erros no Upload:** Se o upload para o Storage falhar, a rota de API não deve gravar a linha no banco de dados (evitar registros "órfãos").
3. **Estado de Carregamento (Loading):** O painel deve exibir esqueletos de carregamento (Skeletons) ou um spinner enquanto busca os dados do Supabase na inicialização.
4. **Estado de Carregamento do Download:** O botão de download no card deve mudar de estado (ex: "Baixando...") enquanto processa o download para evitar cliques duplos.
5. **Lista Vazia (Empty State):** Se o banco de dados não tiver nenhum clone salvo, o painel deve exibir uma mensagem instruindo o usuário a usar a extensão, com uma setinha ou indicação para o botão de "Baixar Extensão" no topo.

---

## 7. Prompt de Instrução de Código para a IA

> "Aja como um Desenvolvedor Full-Stack Sênior especialista em Next.js (App Router), Tailwind CSS e Supabase.
> 
> Com base neste PRD, preciso criar um Painel Web (Dashboard) para listar e baixar páginas web clonadas.
> 
> Passo a passo obrigatório:
> 1. Forneça o comando de terminal exato para inicializar o projeto Next.js.
> 2. Forneça o script SQL exato que devo rodar no painel do Supabase para criar a tabela `clones` e configurar o bucket `cloned-files` corretamente.
> 3. Escreva o código completo da inicialização do cliente Supabase (`lib/supabase.ts`).
> 4. Crie a Rota de API (`app/api/save-clone/route.ts`) implementando a lógica de receber o `FormData` com o arquivo `.zip` e salvá-lo no Supabase.
> 5. Implemente o `app/layout.tsx` criando uma Navbar superior que contenha um botão 'Baixar Extensão'. Este botão deve apontar para `/web-cloner-extension.zip` na pasta `public`.
> 6. Crie a interface em `app/page.tsx` usando um design bonito e moderno com Tailwind CSS (incluindo o Empty State instruindo o usuário a baixar a extensão).
> 7. Crie o componente `CloneCard.tsx` com a lógica de baixar o arquivo do Storage quando o botão for clicado.
> 
> Lembre-se de implementar os Casos de Borda descritos na seção 6. Me entregue os códigos completos e prontos para uso."
