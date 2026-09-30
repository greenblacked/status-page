import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge with the board's own type steps (src/styles.css, --text-*).
 * Without them it reads text-caption as a text colour and drops it whenever a
 * colour such as text-muted follows, and does not know rounded-thumb and
 * rounded-bar are radii.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "headline", "card", "row", "body", "caption", "footnote", "hand", "hand-lg"] }],
      rounded: [{ rounded: ["thumb", "bar"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
