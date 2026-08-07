import { Download } from "lucide-react";

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0b1020]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div
            aria-hidden
            className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 shadow-lg shadow-indigo-500/40"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="13" height="13" rx="3" opacity="0.55" />
              <rect x="8" y="8" width="13" height="13" rx="3" className="fill-white/15" />
              <path d="M14.5 11.5v5m0 0-2-2m2 2 2-2" />
            </svg>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold tracking-tight text-white sm:text-base">
              Web Cloner
            </p>
            <p className="text-[11px] text-slate-400">Painel de clones</p>
          </div>
        </div>

        <a
          href="/web-cloner-extension.zip"
          download
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-sky-500 px-3.5 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          <Download className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Baixar Extensão</span>
          <span className="sm:hidden">Extensão</span>
        </a>
      </div>
    </header>
  );
}
