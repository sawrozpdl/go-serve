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

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/**
 * Left-justify `left`, right-justify `right`, padded with spaces to `cols`.
 * If they would overlap, `left` is truncated to make room for `right`.
 */
export function twoCol(left: string, right: string, cols: number): string {
  const gap = cols - left.length - right.length;
  if (gap >= 0) return left + ' '.repeat(gap) + right;
  // Overlap: truncate left so left + right fills exactly cols chars.
  const leftRoom = Math.max(0, cols - right.length);
  return left.slice(0, leftRoom) + right;
}
