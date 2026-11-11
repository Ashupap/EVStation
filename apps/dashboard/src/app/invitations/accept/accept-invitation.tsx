'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

type State =
  | { status: 'loading' }
  | { status: 'accepted' }
  | { status: 'sign-in' }
  | { status: 'error'; message: string };

export function AcceptInvitation() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const tokenRef = useRef<string | null | undefined>(undefined);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (tokenRef.current === undefined) {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
      tokenRef.current = fragment.get('token');
      window.history.replaceState(null, '', window.location.pathname);
    }

    const token = tokenRef.current;
    if (!token) {
      setState({ status: 'error', message: 'This invitation link is missing its token.' });
      return;
    }

    void fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (response.status === 401) {
          setState({ status: 'sign-in' });
          return;
        }
        if (!response.ok) {
          setState({
            status: 'error',
            message: 'This invitation is invalid, expired, or no longer available.',
          });
          return;
        }
        setState({ status: 'accepted' });
      })
      .catch(() => {
        setState({ status: 'error', message: 'The invitation could not be accepted.' });
      });
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="mt-8" data-testid="invitation-loading">
        <h1 className="text-2xl font-black tracking-tight text-slate-950">Checking invitation</h1>
        <p className="mt-3 text-sm text-slate-600">Please wait while we validate this link.</p>
      </div>
    );
  }

  if (state.status === 'accepted') {
    return (
      <div className="mt-8" data-testid="invitation-accepted">
        <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
          Accepted
        </span>
        <h1 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
          You are now a member
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Your tenant membership is active. Open the operations console to continue.
        </p>
        <Link
          href="/app"
          className="mt-6 inline-flex rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-cyan-700"
        >
          Open console
        </Link>
      </div>
    );
  }

  if (state.status === 'sign-in') {
    return (
      <div className="mt-8" data-testid="invitation-sign-in">
        <h1 className="text-2xl font-black tracking-tight text-slate-950">Sign in to accept</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Sign in with the email address that received this invitation, then reopen the invitation
          link.
        </p>
        <Link
          href="/auth/login"
          className="mt-6 inline-flex rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-cyan-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-8" data-testid="invitation-error">
      <span className="inline-flex rounded-full bg-rose-100 px-3 py-1 text-xs font-bold text-rose-800">
        Not accepted
      </span>
      <h1 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
        Invitation unavailable
      </h1>
      <p role="alert" className="mt-3 text-sm leading-6 text-slate-600">
        {state.message}
      </p>
      <Link href="/login" className="mt-6 inline-flex text-sm font-bold text-cyan-700">
        Go to sign in
      </Link>
    </div>
  );
}
