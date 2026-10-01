// tokens-allow: raw-color (the displacement filter's neutral grey is a map value, not a design colour)

/** How many bubbles there are; src/background.css places each by its position among them. */
const BUBBLES = 11;
const BUBBLE_KEYS = Array.from({ length: BUBBLES }, (_, index) => `bubble-${index + 1}`);

/**
 * The bubbles behind the board: eleven small glass bubbles, each drawing a copy
 * of the aurora's colour and a soft caustic bent through thin-glass refraction
 * (`#lens-refract`), with a bright rim, an iridescent fringe, a crisp specular
 * highlight and a softer reflection opposite it. Static markup, no state, and
 * always rendered, so the server's HTML and the hydrated page agree. Where each
 * bubble sits, how big it is and how it floats (its own path, pace and phase,
 * all fixed numbers, never random) is in src/background.css, which also shows
 * the layer only on the Full background (Quiet and Glass hide it) and gives
 * laptop, tablet and phone widths their own places and fewer bubbles, so none
 * sits over the margin column's bare text.
 *
 * On Full, with a mouse or trackpad, each bubble drifts and breathes slowly,
 * on transform alone and in pure CSS; touch screens and Reduce Motion keep
 * them still. Reduce glass, prefers-reduced-transparency, Increase Contrast and
 * forced colours hide the whole layer.
 *
 * `#lens-refract` is the filter each `.lens-fx` applies. Its displacement map
 * is /lens-map.png, baked by scripts/lens-map.mjs. The SVG holding it must stay
 * rendered, not display:none, or the filter does not resolve, so it is a
 * zero-size sibling of the bubbles rather than inside them.
 */
export function LensField() {
  return (
    <>
      <svg
        width="0"
        height="0"
        aria-hidden
        focusable="false"
        className="pointer-events-none absolute size-0 overflow-hidden"
      >
        <filter
          id="lens-refract"
          x="0"
          y="0"
          width="1"
          height="1"
          filterUnits="objectBoundingBox"
          primitiveUnits="objectBoundingBox"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodColor="rgb(128,128,128)" result="neutral" />
          <feImage
            href="/lens-map.png"
            x="0.1154"
            y="0.1154"
            width="0.7692"
            height="0.7692"
            preserveAspectRatio="none"
            result="mapimg"
          />
          <feMerge result="map">
            <feMergeNode in="neutral" />
            <feMergeNode in="mapimg" />
          </feMerge>
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="0.3846"
            xChannelSelector="R"
            yChannelSelector="G"
            result="main"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="0.42"
            xChannelSelector="R"
            yChannelSelector="G"
            result="wideraw"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="0.35"
            xChannelSelector="R"
            yChannelSelector="G"
            result="tightraw"
          />
          <feFlood style={{ floodColor: "var(--lens-fringe-a)" }} result="ca" />
          <feComposite in="ca" in2="wideraw" operator="in" result="fa" />
          <feFlood style={{ floodColor: "var(--lens-fringe-b)" }} result="cb" />
          <feComposite in="cb" in2="tightraw" operator="in" result="fb" />
          <feMerge>
            <feMergeNode in="fa" />
            <feMergeNode in="fb" />
            <feMergeNode in="main" />
          </feMerge>
        </filter>
      </svg>
      <div className="lenses" aria-hidden>
        {BUBBLE_KEYS.map((key) => (
          <div key={key} className="lens">
            <div className="lens-fx" />
          </div>
        ))}
      </div>
    </>
  );
}
