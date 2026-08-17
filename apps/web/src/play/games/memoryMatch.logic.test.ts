import { describe, expect, it } from 'vitest';

import {
  createMemory,
  flipTile,
  hideTiles,
  memoryScore,
  tickSecond,
} from './memoryMatch.logic';

describe('memory match logic', () => {
  it('deals exactly N pairs from a seed, reproducibly', () => {
    const a = createMemory(42, 'normal');
    const b = createMemory(42, 'normal');
    expect(a.tiles.map((t) => t.symbol)).toEqual(b.tiles.map((t) => t.symbol));

    const counts = new Map<number, number>();
    for (const t of a.tiles) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1);
    expect(counts.size).toBe(a.pairs);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('matching tiles lock face-up', () => {
    const s = createMemory(1, 'gentle');
    const first = 0;
    const second = s.tiles.findIndex((t, i) => i !== first && t.symbol === s.tiles[first]!.symbol);

    expect(flipTile(s, first)).toEqual({ kind: 'revealed' });
    expect(flipTile(s, second)).toEqual({ kind: 'matched', pairsFound: 1 });
    expect(s.tiles[first]!.matched).toBe(true);
    expect(s.tiles[second]!.matched).toBe(true);
  });

  it('mismatched tiles report both indices so the renderer can turn them back', () => {
    const s = createMemory(1, 'gentle');
    const first = 0;
    const other = s.tiles.findIndex((t) => t.symbol !== s.tiles[first]!.symbol);

    flipTile(s, first);
    const result = flipTile(s, other);
    expect(result).toEqual({ kind: 'missed', a: first, b: other });

    hideTiles(s, first, other);
    expect(s.tiles[first]!.revealed).toBe(false);
    expect(s.tiles[other]!.revealed).toBe(false);
  });

  // Fingers slip on a phone. Re-tapping the same card must not burn the pick or
  // count as a second event.
  it('re-tapping a revealed or matched tile is a no-op', () => {
    const s = createMemory(1, 'gentle');
    flipTile(s, 0);
    const events = s.events;
    expect(flipTile(s, 0)).toEqual({ kind: 'ignored' });
    expect(s.events).toBe(events);
  });

  it('scores pairs at 10, and only adds the time bonus on a full clear', () => {
    const s = createMemory(3, 'gentle');
    // Clear the whole board.
    for (let sym = 0; sym < s.pairs; sym++) {
      const idx = s.tiles.map((t, i) => ({ t, i })).filter((x) => x.t.symbol === sym).map((x) => x.i);
      flipTile(s, idx[0]!);
      flipTile(s, idx[1]!);
    }
    expect(s.done).toBe(true);
    expect(memoryScore(s)).toBe(s.pairs * 10 + s.secondsLeft);
  });

  it('a partial board scores its pairs but no time bonus', () => {
    const s = createMemory(3, 'normal');
    const sym = s.tiles[0]!.symbol;
    const idx = s.tiles.map((t, i) => ({ t, i })).filter((x) => x.t.symbol === sym).map((x) => x.i);
    flipTile(s, idx[0]!);
    flipTile(s, idx[1]!);
    expect(memoryScore(s)).toBe(10);
  });

  it('running out of time ends the game', () => {
    const s = createMemory(3, 'normal');
    let ended = false;
    for (let i = 0; i < 200 && !ended; i++) ended = tickSecond(s);
    expect(ended).toBe(true);
    expect(s.done).toBe(true);
    expect(s.secondsLeft).toBe(0);
  });

  it('no further flips are accepted once the game is over', () => {
    const s = createMemory(3, 'normal');
    s.done = true;
    expect(flipTile(s, 0)).toEqual({ kind: 'ignored' });
  });
});
