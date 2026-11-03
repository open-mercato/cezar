import localFont from 'next/font/local';
import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

// Self-hosted (licenses beside the files), so a build needs no font CDN.
const inter = localFont({
  src: [
    { path: './fonts/inter-latin-400-normal.C38fXH4l.woff2', weight: '400' },
    { path: './fonts/inter-latin-ext-400-normal.C1nco2VV.woff2', weight: '400' },
    { path: './fonts/inter-latin-500-normal.Cerq10X2.woff2', weight: '500' },
    { path: './fonts/inter-latin-ext-500-normal.CV4jyFjo.woff2', weight: '500' },
  ],
  variable: '--font-inter',
});

const mono = localFont({
  src: [
    { path: './fonts/jetbrains-mono-latin-400-normal.V6pRDFza.woff2', weight: '400' },
    { path: './fonts/jetbrains-mono-latin-ext-400-normal.Bc8Ftmh3.woff2', weight: '400' },
  ],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: { template: '%s | Cezar', default: 'Cezar documentation' },
  description: 'Learn to use Cezar: tasks, agents, workflows, GitHub, and settings.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
