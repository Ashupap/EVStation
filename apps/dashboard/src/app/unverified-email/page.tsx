import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function UnverifiedEmailPage() {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.principal.email_verified) redirect('/app');

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <section className="w-full max-w-xl rounded-3xl border border-amber-200 bg-white p-8 shadow-xl shadow-amber-100">
        <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
          Action required
        </span>
        <h1 className="mt-5 text-3xl font-black tracking-tight text-slate-950">
          Verify your email address
        </h1>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          We cannot open the operations console for <strong>{auth.principal.email}</strong> until
          your email address is verified. Check your inbox for the verification message, then sign
          in again.
        </p>
        <form action="/auth/logout" method="post" className="mt-8">
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-700"
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
