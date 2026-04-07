import './globals.css';

import { ThemeProvider } from '../components/ThemeProvider';
import { ToasterClient } from '../components/ToasterClient';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen text-zinc-100">
        <ThemeProvider>
          {children}
          <ToasterClient />
        </ThemeProvider>
      </body>
    </html>
  );
}
