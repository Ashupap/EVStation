import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const auth = await getAuthContext();
  redirect(auth ? '/app' : '/login');
}
