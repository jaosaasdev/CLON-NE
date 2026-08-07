import { ClonesPanel } from "@/components/ClonesPanel";

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <section className="mb-8 flex flex-col gap-3 sm:mb-10 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-300/80">
            Biblioteca offline
          </p>
          <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Seus clones
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400 sm:text-base">
            Cada captura feita pela extensão aparece aqui como um card.
            Baixe o .zip completo quando precisar reabrir o site offline.
          </p>
        </div>
      </section>

      <ClonesPanel />
    </div>
  );
}
