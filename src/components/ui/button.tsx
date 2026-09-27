import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[opacity,transform,background-color,color,box-shadow] duration-[var(--motion-quick)] ease-[var(--ease-out)] focus-ring disabled:pointer-events-none disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 active:not-disabled:not-aria-disabled:scale-[0.96] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-bg hover:opacity-90",
        // The whisper material: no blur, so a row of chips costs nothing to scroll.
        outline: "glass-whisper text-fg",
        ghost: "bg-transparent text-muted hover:text-fg hover:bg-surface-2",
        solid: "bg-surface-2 text-fg hover:bg-surface",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 px-3 text-xs",
        lg: "h-12 px-5",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // An unset `type` defaults to "submit"; only a real <button> takes the attribute.
    const typeProps = asChild ? {} : { type: type ?? "button" };
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} {...typeProps} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
