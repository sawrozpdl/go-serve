import { CMD } from './commands';
import { COLS, encodeText } from './codepage';

/** A fluent buffer builder that accumulates ESC/POS bytes. */
export class EscPosBuilder {
  private chunks: number[] = [];
  private cols: number;

  constructor(width: '58' | '80') {
    this.cols = COLS[width];
  }

  raw(bytes: readonly number[] | Uint8Array): this {
    for (const b of bytes) this.chunks.push(b);
    return this;
  }

  init(): this {
    return this.raw(CMD.INIT).raw(CMD.SELECT_CP437);
  }

  text(s: string): this {
    return this.raw(encodeText(s));
  }

  line(s = ''): this {
    return this.text(s).raw(CMD.LF);
  }

  align(a: 'left' | 'center' | 'right'): this {
    if (a === 'center') return this.raw(CMD.ALIGN_CENTER);
    if (a === 'right') return this.raw(CMD.ALIGN_RIGHT);
    return this.raw(CMD.ALIGN_LEFT);
  }

  bold(on: boolean): this {
    return this.raw(on ? CMD.BOLD_ON : CMD.BOLD_OFF);
  }

  doubleSize(on: boolean): this {
    return this.raw(on ? CMD.DOUBLE_ON : CMD.DOUBLE_OFF);
  }

  feed(n = 1): this {
    for (let i = 0; i < n; i++) this.raw(CMD.LF);
    return this;
  }

  rule(ch = '-'): this {
    return this.line(ch.repeat(this.cols));
  }

  cut(): this {
    return this.raw(CMD.FEED_AND_CUT);
  }

  /**
   * Print a QR code with the printer's own encoder (ESC/POS GS ( k, model 2,
   * error correction M) — no raster, no library, works on every Epson-
   * compatible thermal head. `data` must be ASCII: the IRD invoice QR payload
   * is built from PAN digits, bill numbers, dates and amounts only. Anything
   * outside printable ASCII is replaced with '?' rather than sent as garbage.
   * moduleSize is dots per module (1–16); 6 gives ~30 mm on an 80 mm roll.
   */
  qr(data: string, moduleSize = 6): this {
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      bytes.push(c === 0x0a || (c >= 0x20 && c < 0x7f) ? c : 0x3f);
    }
    const len = bytes.length + 3;
    const size = Math.max(1, Math.min(16, Math.round(moduleSize)));
    return this.raw([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]) // model 2
      .raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size]) // module size
      .raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]) // error correction M
      .raw([0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30]) // store
      .raw(bytes)
      .raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]); // print
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/**
 * Left-justify `left`, right-justify `right`, padded with spaces to `cols`.
 * If they would overlap, `left` is truncated to make room for `right`.
 *
 * The truncating branch used to slice `left` to exactly the room left over and
 * butt the two together, so a long item name printed as
 * `1x Cafe+Mocha----@DFRs 250` — no gap, and no sign that anything had been
 * cut. It now reserves one space and spends one more character on an ellipsis,
 * so the line reads as "this name was shortened" and the amount is always
 * legibly separate. `…` is not in CP437, so use '..' which survives the
 * codepage fold in encodeText.
 */
export function twoCol(left: string, right: string, cols: number): string {
  const gap = cols - left.length - right.length;
  if (gap >= 0) return left + ' '.repeat(gap) + right;
  // Overlap. Keep one space between the two, and if that costs us any of the
  // name, say so with '..' rather than cutting silently mid-word.
  const leftRoom = Math.max(0, cols - right.length - 1);
  const cut = leftRoom >= 3 ? left.slice(0, leftRoom - 2) + '..' : left.slice(0, leftRoom);
  return cut + ' '.repeat(Math.max(0, cols - cut.length - right.length)) + right;
}

/**
 * Hard-wrap `s` to `cols` characters, breaking at spaces where it can and
 * mid-token when it must. Returns one string per printed line.
 *
 * The KOT emitted item names with no clamp at all, leaving the wrap to the
 * printer's own firmware — which varies by model and breaks mid-token wherever
 * the head happens to be, splitting the bold run. The cook needs the whole
 * name, so wrap rather than truncate here (unlike the receipt, where the money
 * column has to stay put).
 */
export function wrapLine(s: string, cols: number): string[] {
  if (cols <= 0 || s.length <= cols) return [s];
  const out: string[] = [];
  for (const word of s.split(' ')) {
    if (out.length === 0) {
      out.push(word);
      continue;
    }
    const last = out[out.length - 1]!;
    if (last.length + 1 + word.length <= cols) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  // Any single word still wider than the roll gets chopped into full lines.
  const wrapped: string[] = [];
  for (const l of out) {
    for (let i = 0; i < l.length; i += cols) wrapped.push(l.slice(i, i + cols));
  }
  return wrapped;
}
