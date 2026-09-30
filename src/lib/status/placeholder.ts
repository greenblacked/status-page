/** The parts of an input's computed style that decide how wide its text is drawn. */
export interface InputTextStyle {
  fontStyle: string;
  fontWeight: string;
  fontSize: string;
  fontFamily: string;
  paddingLeft: string;
  paddingRight: string;
}

/** The canvas `font` shorthand that draws text the way the input does. */
export function canvasFont(
  style: Pick<InputTextStyle, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">,
): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** A computed pixel length ("12px") as a number; anything unreadable counts as 0. */
function pixels(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** The width a placeholder needs inside the input: the drawn text plus both paddings. */
export function placeholderWidth(
  textWidth: number,
  style: Pick<InputTextStyle, "paddingLeft" | "paddingRight">,
): number {
  return textWidth + pixels(style.paddingLeft) + pixels(style.paddingRight);
}

/** Whether the placeholder fits whole in a dock this wide. It may fill it exactly. */
export function placeholderFits(dockWidth: number, textWidth: number, style: InputTextStyle): boolean {
  return dockWidth >= placeholderWidth(textWidth, style);
}
