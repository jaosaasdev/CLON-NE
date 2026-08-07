export function CloneSkeleton() {
  return (
    <div
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
      aria-hidden
    >
      <div className="mb-4 flex items-start justify-between">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-white/10" />
        <div className="h-6 w-20 animate-pulse rounded-full bg-white/10" />
      </div>
      <div className="h-5 w-[80%] animate-pulse rounded bg-white/10" />
      <div className="mt-3 h-4 w-[40%] animate-pulse rounded bg-white/10" />
      <div className="mt-8 h-10 w-full animate-pulse rounded-xl bg-white/10" />
    </div>
  );
}

export function ClonesLoadingGrid() {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      role="status"
      aria-live="polite"
      aria-label="Carregando clones"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <CloneSkeleton key={index} />
      ))}
      <span className="sr-only">Carregando lista de clones…</span>
    </div>
  );
}
