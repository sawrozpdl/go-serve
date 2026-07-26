// Reading rendered money off the page.
//
// Kept out of the spec files because Playwright refuses to let one spec import
// another, and both specs need the same parser: the app renders Nepali rupees in
// the lakh grouping convention ("रू 1,23,456.78"), so a naive Number() is wrong.

/** Parse a rendered figure ("रू 1,23,456.78", "रू -50") into paisa. */
export function parseNPR(text: string): number {
  const m = text.replace(/ /g, ' ').match(/-?[\d,]+(\.\d+)?/);
  if (!m) throw new Error(`no number in ${JSON.stringify(text)}`);
  return Math.round(parseFloat(m[0].replace(/,/g, '')) * 100);
}

/** Every figure in a string, in order — for checking that parts sum to a total. */
export function allNPR(text: string): number[] {
  const cleaned = text.replace(/ /g, ' ');
  return [...cleaned.matchAll(/-?[\d,]+(?:\.\d+)?/g)].map((m) =>
    Math.round(parseFloat(m[0].replace(/,/g, '')) * 100),
  );
}
