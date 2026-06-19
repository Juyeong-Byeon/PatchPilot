import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-4 text-sm font-normal outline-none transition-colors disabled:pointer-events-none disabled:border-hairline-gray disabled:bg-linen disabled:text-graphite focus-visible:ring-2 focus-visible:ring-forest-ink/20",
  {
    variants: {
      variant: {
        default: "border-forest-ink bg-forest-ink text-linen-white hover:bg-charcoal",
        outline: "border-hairline-gray bg-linen-white text-forest-ink hover:border-forest-ink hover:bg-linen",
        ghost: "border-transparent bg-transparent text-charcoal hover:bg-linen hover:text-forest-ink",
        danger: "border-forest-ink bg-forest-ink text-linen-white hover:bg-charcoal"
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 rounded-lg px-3 text-xs",
        icon: "size-10 p-0"
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
