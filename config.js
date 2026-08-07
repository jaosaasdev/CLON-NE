/**
 * config.js — URL do Painel Web Cloner (única fonte de verdade).
 *
 * Troque PANEL_ORIGIN ao publicar:
 *   - Local:     http://localhost:3000
 *   - Railway:   https://SEU-SERVICO.up.railway.app
 *
 * Usado por background.js (importScripts) e popup.js (script no HTML).
 */
'use strict';

const PANEL_ORIGIN = 'https://dashboard-production-e51e.up.railway.app';

const WCLONER_CONFIG = {
  PANEL_ORIGIN,
  PANEL_URL: PANEL_ORIGIN.endsWith('/') ? PANEL_ORIGIN : `${PANEL_ORIGIN}/`,
  API_URL: `${PANEL_ORIGIN.replace(/\/$/, '')}/api/save-clone`,
  /** Opcional: mesmo valor de CLONE_API_SECRET do dashboard/.env.local */
  CLONE_API_SECRET: ''
};

// Service worker (importScripts) e popup (script tag) compartilham este objeto.
self.WCLONER_CONFIG = WCLONER_CONFIG;
