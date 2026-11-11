export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="max-w-3xl">
      <p className="text-xs font-bold tracking-[0.18em] text-cyan-700 uppercase">{eyebrow}</p>
      <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>
    </header>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-white/70 p-10 text-center">
      <p className="text-base font-bold text-slate-900">{title}</p>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">{body}</p>
    </div>
  );
}
