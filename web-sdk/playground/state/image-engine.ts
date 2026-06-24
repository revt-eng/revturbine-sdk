/** A locally "generated" demo image (a procedural SVG data URI — no backend). */
export interface GeneratedImage {
  id: string;
  src: string;
  premium: boolean;
}

/** Outcome of a generate attempt. */
export type GenerateOutcome =
  | { ok: true; image: GeneratedImage }
  | { ok: false; reason: 'rate_limited' | 'usage_exhausted' | 'no_credits' };

const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ['#7c5cff', '#29d3c2'],
  ['#ff5c7c', '#f5a623'],
  ['#4f8cff', '#7c5cff'],
  ['#29d3c2', '#9cff57'],
  ['#f5a623', '#ff5c7c'],
  ['#9b5cff', '#4f8cff'],
];

/**
 * Deterministic procedural art so the studio needs no bundled image assets:
 * a gradient + two blobs derived from the generation index, plus a dashed
 * frame for premium-style outputs.
 */
export function makeImage(index: number, premium: boolean): GeneratedImage {
  const [a, b] = PALETTES[index % PALETTES.length];
  const r = 60 + ((index * 37) % 90);
  const cx = 120 + ((index * 53) % 160);
  const cy = 120 + ((index * 29) % 160);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs>` +
    `<rect width='400' height='400' fill='url(#g)'/>` +
    `<circle cx='${cx}' cy='${cy}' r='${r}' fill='rgba(255,255,255,0.25)'/>` +
    `<circle cx='${400 - cx}' cy='${400 - cy}' r='${r / 1.6}' fill='rgba(0,0,0,0.18)'/>` +
    (premium
      ? `<rect x='12' y='12' width='376' height='376' fill='none' stroke='rgba(255,255,255,0.65)' stroke-width='4' stroke-dasharray='10 8'/>`
      : '') +
    `</svg>`;
  return { id: `img-${index}`, src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, premium };
}
