import { Toaster as SonnerToaster } from 'sonner'
import { cn } from '../../lib/utils'

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: 'group toast group-[.toaster]:bg-zinc-800 group-[.toaster]:text-white group-[.toaster]:border-zinc-700 group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-zinc-400',
          actionButton: 'group-[.toast]:bg-violet-600 group-[.toast]:text-white',
          cancelButton: 'group-[.toast]:bg-zinc-700 group-[.toast]:text-zinc-300',
        },
      }}
    />
  )
}
