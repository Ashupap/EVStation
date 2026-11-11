import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthState } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const errors: Record<string, string> = {
  oidc_unavailable: 'The identity provider is unavailable. Try again shortly.',
  login_expired: 'The sign-in attempt expired. Start again.',
  login_failed: 'Sign-in could not be completed. Start again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authState = await getAuthState();
  if (authState.kind === 'ok') redirect('/app');
  const params = await searchParams;
  const errorKey = typeof params.error === 'string' ? params.error : undefined;
  const message = errorKey ? (errors[errorKey] ?? 'Sign-in could not be completed.') : undefined;

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <section className="grid w-full max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-2xl shadow-slate-200/60 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col justify-between gap-12 bg-slate-950 p-8 text-white sm:p-12">
          <div className="flex items-center gap-3">
            <span className="grid size-12 place-items-center rounded-2xl bg-cyan-400 text-lg font-black text-slate-950">
              EV
            </span>
            <span className="text-lg font-black tracking-tight">EVStation</span>
          </div>
          <div>
            <p className="text-xs font-bold tracking-[0.22em] text-cyan-300 uppercase">
              Operator console
            </p>
            <h1 className="mt-5 max-w-md text-4xl font-black tracking-tight sm:text-5xl">
              Keep every charging site in view.
            </h1>
            <p className="mt-5 max-w-md text-sm leading-6 text-slate-300">
              A secure workspace for tenant administrators, site managers and viewers across your EV
              charging network.
            </p>
          </div>
          <p className="text-xs text-slate-500">Phase 1 · Authorized operators only</p>
        </div>

        <div className="flex flex-col justify-center p-8 sm:p-12">
          {authState.kind === 'unavailable' ? (
            <div data-testid="service-unavailable">
              <p className="text-sm font-semibold text-amber-700">Service unavailable</p>
              <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                EVStation API is offline
              </h2>
              <p role="alert" className="mt-3 text-sm leading-6 text-slate-600">
                Sign-in cannot be completed because the EVStation API is temporarily unavailable.
                Try again shortly.
              </p>
              <a
                href="/login"
                className="mt-8 inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              >
                Try again
              </a>
            </div>
          ) : (
            <>
              <p className="text-sm font-semibold text-cyan-700">Welcome back</p>
              <h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Sign in</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                You will be redirected to Keycloak. Your browser never receives an API token.
              </p>
              {message ? (
                <p
                  role="alert"
                  className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
                >
                  {message}
                </p>
              ) : null}
              <a
                href="/auth/login"
                data-testid="login"
                className="mt-8 inline-flex items-center justify-center rounded-xl bg-cyan-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-cyan-600/20 transition hover:bg-cyan-700"
              >
                Continue to sign in
              </a>
              <p className="mt-6 text-xs leading-5 text-slate-500">
                Access is invitation-only. Contact your tenant administrator if you need an account.
              </p>
              <Link
                href="/"
                className="mt-6 text-xs font-semibold text-slate-500 hover:text-slate-800"
              >
                Back to EVStation
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
