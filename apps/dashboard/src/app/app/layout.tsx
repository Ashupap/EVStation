import { Sidebar } from '@/components/sidebar';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar auth={auth} />
      <main className="min-w-0 flex-1 px-5 py-8 sm:px-8 lg:px-14 lg:py-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
