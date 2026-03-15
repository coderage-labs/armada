import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-zinc-700/50 text-zinc-200 hover:bg-zinc-700/50 border border-zinc-700",
        primary:
          "bg-gradient-to-r from-teal-400 to-blue-600 text-white shadow hover:opacity-90",
        destructive:
          "border border-red-500/30 bg-red-500/20 text-red-400 hover:bg-red-500/30",
        outline:
          "border border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-700/50 hover:text-zinc-100",
        secondary:
          "bg-zinc-800 text-zinc-300 border border-zinc-800 hover:bg-zinc-700 hover:text-zinc-100",
        ghost:
          "text-zinc-400 hover:bg-zinc-700/50 hover:text-zinc-200",
        link:
          "text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 rounded-md px-3 py-1.5 text-xs",
        lg: "h-11 rounded-xl px-6 py-3 text-base",
        icon: "h-9 w-9 rounded-lg p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
