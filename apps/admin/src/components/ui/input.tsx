import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 min-w-0 rounded-lg border border-hairline-gray bg-linen-white px-3 text-[13px] text-true-black outline-none transition-colors placeholder:text-graphite/60 hover:border-graphite focus:border-electric-blue focus:ring-2 focus:ring-electric-blue/10 disabled:cursor-not-allowed disabled:bg-linen disabled:text-graphite",
        className,
      )}
      {...props}
    />
  );
}
