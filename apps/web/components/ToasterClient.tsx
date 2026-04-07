'use client';

import { Toaster } from 'sonner';

export function ToasterClient() {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        classNames: {
          toast: 'border border-matrix-500/20 bg-black/80 text-zinc-100',
          title: 'text-zinc-100',
          description: 'text-zinc-300'
        }
      }}
    />
  );
}

