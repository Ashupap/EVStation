import Link from 'next/link';
import { AcceptInvitation } from './accept-invitation';

export const dynamic = 'force-dynamic';

export default function AcceptInvitationPage() {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <section className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/70">
        <Link href="/" className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-2xl bg-cyan-600 text-sm font-black text-white">
            EV
          </span>
          <span className="text-sm font-black tracking-tight text-slate-950">EVStation</span>
        </Link>
        <AcceptInvitation />
      </section>
    </main>
  );
}
