"use client";

import { useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import type { CloneRecord } from "@/lib/supabase";
import { getPublicFileUrl } from "@/lib/supabase";

type Props = {
  clone: CloneRecord;
};

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const diffMs = date.getTime() - Date.now();
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

  if (absSec < 60) return rtf.format(Math.round(diffMs / 1000), "second");
  if (absSec < 3600) return rtf.format(Math.round(diffMs / 60000), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diffMs / 3600000), "hour");
  if (absSec < 86400 * 30) return rtf.format(Math.round(diffMs / 86400000), "day");

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function downloadFilename(clone: CloneRecord): string {
  const base = clone.storage_path.split("/").pop() || "clone.zip";
  return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
}

export function CloneCard({ clone }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setError(null);

    try {
      const publicUrl = getPublicFileUrl(clone.storage_path);
      const response = await fetch(publicUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadFilename(clone);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      console.error("[CloneCard] download failed:", err);
      setError("Não foi possível baixar. Tente novamente.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-5 shadow-[0_20px_50px_-35px_rgba(79,100,255,0.55)] transition duration-200 hover:-translate-y-0.5 hover:border-indigo-400/30 hover:bg-white/[0.05]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sky-400/50 to-transparent opacity-0 transition group-hover:opacity-100"
      />

      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-sm font-semibold text-white shadow-lg shadow-indigo-500/30">
          {hostLabel(clone.original_url).slice(0, 1).toUpperCase()}
        </div>
        <time
          dateTime={clone.created_at}
          className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-slate-400"
        >
          {formatRelativeDate(clone.created_at)}
        </time>
      </div>

      <h3 className="line-clamp-2 font-heading text-lg font-semibold leading-snug tracking-tight text-slate-50">
        {clone.title || "Sem título"}
      </h3>

      <a
        href={clone.original_url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex max-w-full items-center gap-1.5 text-sm text-sky-300/90 transition hover:text-sky-200"
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{hostLabel(clone.original_url)}</span>
      </a>

      <div className="mt-auto pt-5">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          aria-busy={downloading}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {downloading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Baixando...
            </>
          ) : (
            <>
              <Download className="h-4 w-4" aria-hidden />
              Baixar Arquivos (.zip)
            </>
          )}
        </button>
        {error ? <p className="mt-2 text-center text-xs text-rose-300">{error}</p> : null}
      </div>
    </article>
  );
}
