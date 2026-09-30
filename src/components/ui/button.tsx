import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const CONTROL =
  "control text-fg aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:shadow-[inset_0_0_0_var(--hair)_var(--color-hairline)]";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-body font-medium pressable focus-ring disabled:pointer-events-none disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-bg hover:opacity-90",
        // The inset fill; pressed (a toggle) it becomes the card with a hairline, as a segment's thumb does.
        control: CONTROL,
        // Transitional name for `control`, until the last caller says control.
        outline: CONTROL,
        ghost: "bg-transparent text-muted hover:text-fg hover:bg-inset",
      },
      size: {
        default: "h-11 px-4",
        // A finger is bigger than the 36px control: on a touch screen it is 44pt, and never narrower.
        sm: "h-9 px-2.5 text-caption pointer-coarse:h-11 pointer-coarse:min-w-11",
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
