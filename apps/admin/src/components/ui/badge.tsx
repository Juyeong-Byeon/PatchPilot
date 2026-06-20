import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva("inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[12px] font-medium leading-4 shadow-sm", {
  variants: {
    variant: {
      default: "border-transparent bg-mist-blue text-forest-ink shadow-electric-blue/10",
      outline: "border-hairline-gray bg-linen-white text-charcoal shadow-midnight-ink/5",
      warning: "border-transparent bg-linen text-cobalt-surface shadow-cobalt-surface/10",
      danger: "border-danger bg-danger-wash text-danger shadow-danger/10",
      dark: "border-transparent bg-forest-ink text-linen-white shadow-midnight-ink/15"
    }
  },
  defaultVariants: {
    variant: "default"
  }
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
