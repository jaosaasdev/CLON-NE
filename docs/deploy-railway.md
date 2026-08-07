# Deploy no Railway (painel Next.js)

**Produção:** https://dashboard-production-e51e.up.railway.app

O app fica em `dashboard/`. No Railway, o serviço usa **Root Directory = `dashboard`**.

## Variáveis obrigatórias no serviço Railway

| Variável | Valor |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://gzeacecuhttwcufeffxz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (anon key do projeto Supabase) |
| `SUPABASE_SERVICE_ROLE_KEY` | (opcional, recomendado) |
| `CLONE_API_SECRET` | (opcional) |

> `NEXT_PUBLIC_*` entram no **build** do Next.js — defina antes do primeiro deploy.

## Deploy via GitHub (recomendado)

1. Push deste repositório para o GitHub.
2. Em [railway.app/new](https://railway.app/new) → **Deploy from GitHub repo** → `jaosaasdev/CLON-NE`.
3. Settings do serviço:
   - **Root Directory:** `dashboard`
   - (Dockerfile em `dashboard/` é detectado automaticamente)
4. Em **Variables**, adicione as variáveis da tabela acima.
5. **Networking → Generate Domain** (a porta pública deve bater com a `PORT` do container — no Railway costuma ser `8080`).
6. Atualize a extensão com a URL pública:

```bash
# na raiz do repo
node tools/set-panel-url.js https://dashboard-production-e51e.up.railway.app
```

Isso altera `config.js`, atualiza o `manifest.json` se necessário e regenera o ZIP em `dashboard/public/`.

7. Recarregue a extensão em `chrome://extensions`.

## Deploy via CLI

```bash
npm i -g @railway/cli
railway login
cd dashboard
railway init
railway variables set NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=...
railway up
railway domain --port 8080
node ../tools/set-panel-url.js https://SEU-DOMINIO.up.railway.app
```
