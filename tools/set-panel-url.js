#!/usr/bin/env node
/**
 * Atualiza PANEL_ORIGIN em config.js para a URL do Railway (ou localhost).
 *
 * Uso:
 *   node tools/set-panel-url.js https://meu-app.up.railway.app
 *   node tools/set-panel-url.js http://localhost:3000
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "config.js");
const manifestPath = path.join(root, "manifest.json");

const raw = process.argv[2];
if (!raw) {
  console.error("Uso: node tools/set-panel-url.js <url>");
  console.error("Ex.: node tools/set-panel-url.js https://clon-ne-production.up.railway.app");
  process.exit(1);
}

let origin;
try {
  const u = new URL(raw);
  origin = `${u.protocol}//${u.host}`;
} catch {
  console.error("URL inválida:", raw);
  process.exit(1);
}

let config = fs.readFileSync(configPath, "utf8");
if (!/const PANEL_ORIGIN = ['"][^'"]+['"]/.test(config)) {
  console.error("Não encontrei PANEL_ORIGIN em config.js");
  process.exit(1);
}

config = config.replace(
  /const PANEL_ORIGIN = ['"][^'"]+['"]/,
  `const PANEL_ORIGIN = '${origin}'`
);
fs.writeFileSync(configPath, config, "utf8");
console.log("config.js → PANEL_ORIGIN =", origin);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const perms = new Set(manifest.host_permissions || []);
perms.add("http://localhost:3000/*");
perms.add("http://127.0.0.1:3000/*");
perms.add("https://*.up.railway.app/*");
if (origin.startsWith("https://") && !origin.includes("up.railway.app")) {
  perms.add(`${origin}/*`);
}
manifest.host_permissions = Array.from(perms);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("manifest.json host_permissions atualizado");

// Regenera o ZIP da extensão se o dashboard existir.
const zipScript = path.join(root, "tools", "pack-extension.ps1");
try {
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${zipScript}"`,
      { stdio: "inherit" }
    );
  } else {
    console.log("(pulei o reempacotamento do ZIP — rode tools/pack-extension manualmente)");
  }
} catch (err) {
  console.warn("Aviso: não foi possível regenerar o ZIP automaticamente.", err.message);
}

console.log("\nPronto. Recarregue a extensão em chrome://extensions.");
