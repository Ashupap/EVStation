import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EVStation',
  description: 'EV charging operations console',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen text-slate-900 antialiased">{children}</body>
    </html>
  );
}
