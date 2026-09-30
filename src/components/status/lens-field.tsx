/**
 * The liquid-glass lenses behind the board: four static glass discs, each
 * drawing a copy of the drafting grid bent through thick-glass refraction with
 * a coloured fringe at its rim (the aurora itself is not bent). Static markup,
 * no state: src/styles.css places and sizes them. Reduced motion stops only
 * the rim light's slow orbit; Reduce glass, prefers-reduced-transparency,
 * Increase Contrast and forced colours hide the whole layer.
 *
 * `#lens-refract` is the filter each `.lens-fx` applies. Its displacement map
 * is /lens-map.png, baked by scripts/lens-map.mjs. The SVG holding it must stay
 * rendered, not display:none, or the filter does not resolve, so it is a
 * zero-size sibling of the lenses rather than inside them.
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
        <div className="lens">
          <div className="lens-fx" />
        </div>
        <div className="lens">
          <div className="lens-fx" />
        </div>
        <div className="lens">
          <div className="lens-fx" />
        </div>
        <div className="lens">
          <div className="lens-fx" />
        </div>
      </div>
    </>
  );
}
