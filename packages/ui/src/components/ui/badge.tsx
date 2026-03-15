import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-teal-500/30 bg-teal-500/20 text-teal-300",
        secondary:
          "border-zinc-700 bg-zinc-700/50 text-zinc-300",
        destructive:
          "border-red-500/30 bg-red-500/20 text-red-400",
        outline:
          "border-zinc-600 bg-transparent text-zinc-400",
        // Status variants
        success:
          "border-green-500/30 bg-green-500/20 text-green-300",
        warning:
          "border-amber-500/30 bg-amber-500/20 text-amber-300",
        info:
          "border-blue-500/30 bg-blue-500/20 text-blue-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
