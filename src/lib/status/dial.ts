/**
 * The period dial's tick ring as SVG path data, in a 100 x 100 box centred
 * on 50,50: one radial tick per step, clockwise from twelve o'clock, split
 * into three paths so each length can take its own stroke. Pure, so the
 * server and the browser draw the same markup.
 */
export type DialTicks = {
  /** Every tick that is neither a major nor a quarter. */
  minor: string;
  /** Every `majorEvery`th tick, except the quarters. */
  major: string;
  /** The ticks at twelve, three, six and nine o'clock. */
  quarter: string;
};

export type DialTickOptions = {
  count?: number;
  /** Where every tick starts, from the centre. */
  outer?: number;
  minorLength?: number;
  majorLength?: number;
  quarterLength?: number;
  majorEvery?: number;
};

const round = (value: number) => Number(value.toFixed(2));

function segment(angle: number, outer: number, length: number): string {
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const inner = outer - length;
  return `M${round(50 + outer * sin)} ${round(50 - outer * cos)}L${round(50 + inner * sin)} ${round(50 - inner * cos)}`;
}

export function dialTicks({
  count = 120,
  outer = 49,
  minorLength = 3.5,
  majorLength = 6.5,
  quarterLength = 9.5,
  majorEvery = 10,
}: DialTickOptions = {}): DialTicks {
  const minor: string[] = [];
  const major: string[] = [];
  const quarter: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * 2 * Math.PI;
    if (count % 4 === 0 && index % (count / 4) === 0) quarter.push(segment(angle, outer, quarterLength));
    else if (index % majorEvery === 0) major.push(segment(angle, outer, majorLength));
    else minor.push(segment(angle, outer, minorLength));
  }
  return { minor: minor.join(""), major: major.join(""), quarter: quarter.join("") };
}
