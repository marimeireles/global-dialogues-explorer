// Colour by the job the option list does: ordered scales get a ramp (diverging with a grey
// midpoint, or one hue), nominal options get the fixed categorical slots. "Don't know"-type
// options always wear neutral grey so they never read as a point on the scale.

const THEMES = {
  light: {
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    // Arms shift hue as well as lightness (red -> orange, sky -> deep blue) so neighbouring
    // steps separate clearly; the midpoint stays a hue-less grey.
    negative: ['#cf3a2b', '#f6a05e'], // pole -> towards the midpoint
    positive: ['#86c0e6', '#23509f'], // towards the midpoint -> pole
    midpoint: '#d5d4cd',
    // Ordered scales: one direction of lightness, with a green -> teal -> blue -> indigo drift.
    sequential: ['#bfe3a4', '#5cc2ae', '#2f9fc4', '#2b6cb5', '#2a3a8f'],
    neutral: '#9a988f',
    single: '#2a78d6',
  },
  dark: {
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    negative: ['#e5503f', '#f0a064'],
    positive: ['#8cc4ea', '#3f6fd0'],
    midpoint: '#55544f',
    sequential: ['#d9f0a6', '#6fcdb4', '#3aa6cc', '#3b7fd0', '#5a5fd6'],
    neutral: '#6f6e68',
    single: '#3987e5',
  },
};

const NEUTRAL = /^(i\s)?(do\s?n[o']?t know|unsure|not sure|i'?m not sure|prefer not|none of|not applicable|n\/a|other$|other )/i;
const POLE = /\b(strongly|profoundly|far|much|very|completely|extremely)\b/i;
const NEGATIVE = /distrust|worse|risks far|less\b|disagree|oppose|unlikely|negative|harm/i;
const LADDER = /^(daily|weekly|monthly|annually|never|once or twice|several times|regularly|rarely|sometimes|often|always|not at all|a little|somewhat|a lot|very much|less than 18|\d\d-\d\d|\d\d\+)$/i;

export const MAX_NOMINAL = 8;

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function lerp(a, b, t) {
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
/** n colours sampled evenly along a multi-stop ramp. */
function ramp(stops, n) {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    return lerp(stops[k], stops[k + 1], t - k);
  });
}

export function scaleType(options) {
  const scale = options.filter((o) => !NEUTRAL.test(o));
  if (scale.length >= 4 && POLE.test(scale[0]) && POLE.test(scale.at(-1))) return 'diverging';
  if (scale.length >= 3 && scale.every((o) => LADDER.test(o.trim()))) return 'sequential';
  return 'nominal';
}

/**
 * Map each option (in survey order) to a fill.
 * Nominal lists longer than the palette get colours for the first MAX_NOMINAL-1 entries of
 * `priority` (the caller's ranking, e.g. by overall count); the rest are returned in `folded`
 * for the caller to merge into one grey "Other options" segment.
 */
export function optionColors(options, { dark = false, priority = options } = {}) {
  const t = THEMES[dark ? 'dark' : 'light'];
  const type = scaleType(options);
  const scale = options.filter((o) => !NEUTRAL.test(o));
  const fills = new Map(options.map((o) => [o, t.neutral]));
  let folded = [];

  if (type === 'diverging') {
    const half = Math.floor(scale.length / 2);
    let cols = [...ramp(t.negative, half), ...(scale.length % 2 ? [t.midpoint] : []), ...ramp(t.positive, half)];
    // the red arm goes to whichever end reads as the negative pole
    if (!NEGATIVE.test(scale[0]) && NEGATIVE.test(scale.at(-1))) cols = cols.reverse();
    scale.forEach((o, i) => fills.set(o, cols[i]));
  } else if (type === 'sequential') {
    ramp(t.sequential, scale.length).forEach((c, i) => fills.set(scale[i], c));
  } else {
    const ranked = scale.length > MAX_NOMINAL ? priority.filter((o) => scale.includes(o)).slice(0, MAX_NOMINAL - 1) : scale;
    const keep = scale.filter((o) => ranked.includes(o)); // slots follow survey order, not rank
    keep.forEach((o, i) => fills.set(o, t.categorical[i]));
    folded = scale.filter((o) => !ranked.includes(o));
  }
  return { type, fills, folded, neutral: t.neutral, single: t.single };
}

export const isDark = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
