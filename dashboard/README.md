# Web Cloner Dashboard

Painel Next.js (App Router) + Tailwind + Supabase para listar e baixar sites clonados pela extensão.

## Comando de inicialização (já executado)

```bash
npx create-next-app@latest dashboard --typescript --tailwind --eslint --app --src-dir=false --import-alias "@/*" --turbopack --use-npm --yes
```

## Setup local

1. Copie as variáveis:

```bash
cd dashboard
copy .env.example .env.local
```

2. Preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` (já configurados no `.env.local` deste repo).

3. (Opcional) Adicione `SUPABASE_SERVICE_ROLE_KEY` em **Supabase → Settings → API**.

4. SQL do banco/bucket: `docs/supabase-setup.sql` (já aplicado no projeto `clon-ne`).

5. Rode o painel:

```bash
npm run dev
```

Abra http://localhost:3000

## API da extensão

`POST /api/save-clone` com `FormData`:

- `title` — título da página
- `url` — URL original
- `file` — arquivo `.zip`

Headers opcionais: `X-Clone-Secret` (se `CLONE_API_SECRET` estiver definido).

Limite: **50 MB** (`proxyClientMaxBodySize` + validação na rota + bucket).
