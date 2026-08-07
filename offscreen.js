/**
 * offscreen.js — ponte para APIs de DOM indisponíveis no service worker.
 *
 * O service worker MV3 não expõe `URL.createObjectURL`, então ele não consegue transformar
 * o .zip em uma URL baixável. Este documento offscreen recebe o ZIP em base64, monta um
 * Blob real e devolve o `blob:` URL, que a API chrome.downloads aceita normalmente.
 */

'use strict';

/** Converte base64 em Uint8Array em blocos, evitando estouro de pilha em arquivos grandes. */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;

  if (message.type === 'WEB_CLONER_CREATE_BLOB_URL') {
    try {
      const blob = new Blob([base64ToBytes(message.base64)], { type: 'application/zip' });
      sendResponse(URL.createObjectURL(blob));
    } catch (error) {
      console.error('[Web Cloner/offscreen] Falha ao criar o Blob:', error);
      sendResponse(null);
    }
    return undefined;
  }

  if (message.type === 'WEB_CLONER_REVOKE_BLOB_URL') {
    try {
      URL.revokeObjectURL(message.blobUrl);
    } catch { /* já revogado */ }
    sendResponse(true);
  }

  return undefined;
});
