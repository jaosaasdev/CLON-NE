"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { CloneCard } from "@/components/CloneCard";
import { ClonesLoadingGrid } from "@/components/CloneSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { supabase, type CloneRecord } from "@/lib/supabase";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; clones: CloneRecord[] }
  | { status: "error"; message: string };

export function ClonesPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  async function loadClones() {
    setState({ status: "loading" });

    const { data, error } = await supabase
      .from("clones")
      .select("id, title, original_url, storage_path, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      setState({
        status: "error",
        message: error.message || "Não foi possível carregar os clones.",
      });
      return;
    }

    setState({ status: "ready", clones: (data ?? []) as CloneRecord[] });
  }

  useEffect(() => {
    void loadClones();
  }, []);

  if (state.status === "loading") {
    return <ClonesLoadingGrid />;
  }

  if (state.status === "error") {
    return (
      <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-6 text-rose-100">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Falha ao buscar os clones</p>
            <p className="mt-1 text-sm text-rose-200/80">{state.message}</p>
            <button
              type="button"
              onClick={() => void loadClones()}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm font-medium transition hover:bg-rose-500/20"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Tentar novamente
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state.clones.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {state.clones.map((clone) => (
        <CloneCard key={clone.id} clone={clone} />
      ))}
    </div>
  );
}
