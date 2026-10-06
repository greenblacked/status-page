import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Background } from "@/lib/status/background";
import { SettingsDialog } from "./settings-dialog";
import type { TiltStatus } from "./use-tilt-lighting";

const noop = () => {};

function render(
  options: {
    background?: Background;
    reduceGlass?: boolean;
    singleKey?: boolean;
    tilt?: { supported: boolean; enabled?: boolean; status?: TiltStatus };
  } = {},
): string {
  const tilt = options.tilt ?? { supported: false };
  return renderToStaticMarkup(
    createElement(SettingsDialog, {
      opened: null,
      onClose: noop,
      singleKey: options.singleKey ?? true,
      onSingleKeyChange: noop,
      reduceGlass: options.reduceGlass ?? false,
      onReduceGlassChange: noop,
      background: { value: options.background ?? "quiet", onChange: noop },
      tilt: { supported: tilt.supported, enabled: tilt.enabled ?? false, status: tilt.status ?? "off", onChange: noop },
    }),
  );
}

describe("SettingsDialog", () => {
  it("is a dialog named Settings, closed by a button that says what it closes", () => {
    const html = render();
    expect(html).toContain('aria-labelledby="settings-heading"');
    expect(html).toMatch(/<h2 id="settings-heading"[^>]*>Settings<\/h2>/);
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain("sheet");
  });

  it("starts with the Background choice: three radios, Quiet the default", () => {
    const html = render();
    expect(html.indexOf("Background")).toBeGreaterThan(-1);
    expect(html.indexOf("Background")).toBeLessThan(html.indexOf("Reduce glass"));
    expect(html).toContain("<legend");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio).toContain('name="background"');
    expect(radios.map((radio) => radio.match(/value="(\w+)"/)?.[1])).toEqual(["quiet", "glass", "full"]);
    expect(radios.filter((radio) => radio.includes("checked"))).toHaveLength(1);
    expect(radios[0]).toContain("checked");
    for (const label of ["Quiet", "Glass", "Full"]) expect(html).toContain(`>${label}</label>`);
  });

  it("checks the chosen background and says what it is", () => {
    const hints: Record<Background, string> = {
      quiet: "Flat paper. Nothing moves behind the page.",
      glass: "Frosted panels over a still glow, with a soft light that wanders across the cards.",
      full: "Adds the slow drift and glass lenses to Glass.",
    };
    for (const background of ["quiet", "glass", "full"] as const) {
      const html = render({ background });
      const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
      expect(radios.find((radio) => radio.includes("checked"))).toContain(`value="${background}"`);
      expect(html).toMatch(new RegExp(`<p id="background-hint" role="status"[^>]*>${hints[background]}</p>`));
    }
  });

  it("says that Reduce glass keeps the page solid", () => {
    expect(render({ reduceGlass: true })).toContain("Reduce glass is on, so the page stays solid.");
    expect(render({ reduceGlass: false })).not.toContain("so the page stays solid");
  });

  it("describes each setting in the board's voice", () => {
    const html = render({ tilt: { supported: true } });
    expect(html).toContain("Solid panels and a still background. Easier to read, lighter on old phones.");
    expect(html).toContain("Highlights follow your phone&#x27;s tilt. Asks for motion access the first time.");
    expect(html).toContain("Letter and number keys. Turn them off if they clash with voice input. Esc still works.");
    expect(html).toContain(">Keyboard shortcuts</h3>");
  });

  it("shows the Tilt lighting row only where the device can report its tilt", () => {
    expect(render()).not.toContain("Tilt lighting");
    expect(render({ tilt: { supported: true } })).toContain("Tilt lighting");
  });

  it("says what it takes to get Tilt lighting to draw", () => {
    const note = (options: Parameters<typeof render>[0]) => {
      const html = render(options);
      return html.match(/<p role="status" class="mt-1[^>]*>([^<]*)<\/p>/)?.[1];
    };
    // Paused on Quiet: it needs a background that draws light.
    expect(note({ background: "quiet", tilt: { supported: true, enabled: true, status: "paused" } })).toBe(
      "Needs the Glass or Full background.",
    );
    // Paused with Reduce glass on: that is the reason, whichever background.
    expect(
      note({ background: "quiet", reduceGlass: true, tilt: { supported: true, enabled: true, status: "paused" } }),
    ).toBe("Paused while Reduce glass or Reduce Motion is on.");
    expect(note({ background: "glass", tilt: { supported: true, enabled: true, status: "paused" } })).toBe(
      "Paused while Reduce glass or Reduce Motion is on.",
    );
    // Off or on: nothing to say.
    expect(note({ background: "glass", tilt: { supported: true, enabled: true, status: "on" } })).toBe("");
    expect(note({ background: "quiet", tilt: { supported: true, status: "off" } })).toBe("");
  });

  it("keeps the notes the audits rewrote, and the two that stay as they were", () => {
    const say = (status: TiltStatus) => {
      const html = render({ background: "glass", tilt: { supported: true, status } });
      return html.match(/<p role="status" class="mt-1[^>]*>([^<]*)<\/p>/)?.[1];
    };
    expect(say("denied")).toBe("Motion access was declined. Quit the browser and reopen this page to be asked again.");
    expect(say("no-readings-dropped")).toBe("Your device sent no motion data, so I switched tilt lighting off.");
    expect(say("needs-permission")).toBe("Motion access lapsed. Turn the switch off and on to allow it again.");
    expect(say("no-sensor")).toBe("This device has no motion sensor.");
    expect(say("no-readings")).toBe("No motion readings arrived from this device.");
  });

  it("lists the shortcuts, dimming the single-key ones that are switched off", () => {
    expect(render({ singleKey: true })).not.toContain("(switched off)");
    expect(render({ singleKey: false })).toContain("(switched off)");
  });
});
