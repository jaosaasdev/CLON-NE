"use client";

import { ArrowUpRight, Puzzle, PackageOpen } from "lucide-react";

export function EmptyState() {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-dashed border-indigo-300/25 bg-gradient-to-b from-indigo-500/10 via-transparent to-sky-500/5 px-6 py-16 text-center sm:px-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-8 hidden w-44 rotate-6 text-sky-300/80 sm:block"
      >
        <svg viewBox="0 0 180 120" fill="none" className="h-auto w-full">
          <path
            d="M20 95 C 55 95, 70 40, 120 28"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray="5 7"
          />
          <path
            d="M108 18 L128 28 L110 42"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="mt-1 text-right font-heading text-xs font-medium tracking-wide text-sky-200/90">
          Baixe a extensão aqui ↑
        </p>
      </div>

      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 shadow-xl shadow-indigo-500/30">
        <PackageOpen className="h-8 w-8 text-white" aria-hidden />
      </div>

      <h2 className="mt-6 font-heading text-2xl font-semibold tracking-tight text-white sm:text-3xl">
        Nenhum clone por aqui ainda
      </h2>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-slate-400 sm:text-base">
        Instale a extensão Web Cloner, abra qualquer site e clone a página.
        Os arquivos .zip aparecem automaticamente neste painel.
      </p>

      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <a
          href="/web-cloner-extension.zip"
          download
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-sky-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          <Puzzle className="h-4 w-4" aria-hidden />
          Baixar Extensão
          <ArrowUpRight className="h-4 w-4 opacity-80" aria-hidden />
        </a>
        <span className="text-xs text-slate-500">
          Depois: chrome://extensions → Modo desenvolvedor → Carregar sem compactação
        </span>
      </div>
    </section>
  );
}
