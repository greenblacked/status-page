import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-full px-4 text-sm text-fg glass-whisper",
          "placeholder:text-subtle outline-none transition-[box-shadow] duration-[var(--motion-quick)]",
          "focus-ring focus-visible:shadow-[var(--shadow-border-hover)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        suppressHydrationWarning
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
