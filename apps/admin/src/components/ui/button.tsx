import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium outline-none transition-colors disabled:pointer-events-none disabled:border-hairline-gray disabled:bg-linen disabled:text-graphite focus-visible:ring-2 focus-visible:ring-electric-blue/20",
  {
    variants: {
      variant: {
        default: "border-cobalt-surface bg-cobalt-surface text-paper hover:border-electric-blue hover:bg-electric-blue",
        outline: "border-hairline-gray bg-linen-white text-forest-ink hover:border-electric-blue hover:bg-mist-blue hover:text-forest-ink",
        ghost: "border-transparent bg-transparent text-charcoal hover:bg-mist-blue hover:text-forest-ink",
        danger: "border-forest-ink bg-forest-ink text-linen-white hover:bg-charcoal"
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-3 text-xs",
        icon: "size-9 p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
