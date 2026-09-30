import type { CSSProperties } from "react";
import type { Health } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/**
 * What a status is drawn as: a shape, a weight and a colour, always with the word
 * beside it. The shapes differ in silhouette and in fill, so the set survives
 * every form of colour blindness and greyscale. The healthier a thing is, the
 * lighter its mark: an outline for operational, solid only for what needs a
 * person.
 *
 *   operational  outline circle + check       stroke only   ok
 *   degraded     solid triangle + !           solid         warn
 *   outage       solid octagon + x            solid         down
 *   unknown      dashed circle + ?            dashed        unknown
 *   maintenance  half-filled circle           half          muted
 *
 * Two optical sizes, like the type: at 18px and above the glyph is cut with its
 * detail (the check, the bar, the cross); below that it is the silhouette alone,
 * with a sturdier stroke.
 */
export const STATUS_TEXT: Record<Health, string> = {
  operational: "text-ok",
  degraded: "text-warn",
  outage: "text-down",
  unknown: "text-unknown",
  maintenance: "text-muted",
};

/** The smallest size that carries the detail. */
export const GLYPH_DETAIL_MIN = 18;

/** The ground a glyph's cut-outs must match: the card by default, the page or an inset when it sits there. */
const CUT: Record<"card" | "bg" | "inset", string> = {
  card: "var(--color-card)",
  bg: "var(--color-bg)",
  inset: "var(--color-inset)",
};

/** The outage octagon's corners, summed once: a Math.cos here could differ by a digit between server and browser. */
const OCTAGON = "M20.87 15.67L15.67 20.87L8.33 20.87L3.13 15.67L3.13 8.33L8.33 3.13L15.67 3.13L20.87 8.33z";

/**
 * A status mark, in `currentColor` (give it STATUS_TEXT[health]). Always
 * aria-hidden: the word beside it is the status.
 */
export function StatusGlyph({
  health,
  size = 20,
  className,
  cut,
}: {
  health: Health;
  size?: number;
  className?: string;
  cut?: "card" | "bg" | "inset";
}) {
  const detail = size >= GLYPH_DETAIL_MIN;
  // Strokes get sturdier as the glyph gets smaller.
  const sw = detail ? 1.7 : 2.2;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      data-health={health}
      className={cn("shrink-0", className)}
      style={cut ? ({ "--glyph-cut": CUT[cut] } as CSSProperties) : undefined}
    >
      {health === "operational" ? (
        <>
          <circle cx="12" cy="12" r={detail ? 9.4 : 9} fill="none" stroke="currentColor" strokeWidth={sw} />
          {detail ? (
            <path
              d="M7.7 12.5l3 2.9 5.7-6.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </>
      ) : null}
      {health === "degraded" ? (
        <>
          <path
            d="M12 3.6L21 19.4H3z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          {detail ? (
            <>
              <path d="M12 9.6v4.4" stroke="var(--glyph-cut)" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="12" cy="16.9" r="1.15" fill="var(--glyph-cut)" />
            </>
          ) : null}
        </>
      ) : null}
      {health === "outage" ? (
        <>
          <path d={OCTAGON} fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          {detail ? (
            <path
              d="M8.9 8.9l6.2 6.2M15.1 8.9l-6.2 6.2"
              stroke="var(--glyph-cut)"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          ) : null}
        </>
      ) : null}
      {health === "unknown" ? (
        <>
          <circle
            cx="12"
            cy="12"
            r="9.2"
            fill="none"
            stroke="currentColor"
            strokeWidth={sw}
            strokeDasharray={detail ? "3.1 2.6" : "2.6 2.4"}
            strokeLinecap="round"
          />
          {detail ? (
            <>
              <path
                d="M9.7 9.7c0-1.4 1.1-2.3 2.4-2.3s2.3.8 2.3 2.1c0 1.7-2.4 1.9-2.4 3.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <circle cx="12" cy="16.6" r="1.05" fill="currentColor" />
            </>
          ) : null}
        </>
      ) : null}
      {health === "maintenance" ? (
        <>
          <circle cx="12" cy="12" r="9.4" fill="none" stroke="currentColor" strokeWidth={sw} />
          <path d="M12 5.2a6.8 6.8 0 0 0 0 13.6z" fill="currentColor" />
        </>
      ) : null}
    </svg>
  );
}
