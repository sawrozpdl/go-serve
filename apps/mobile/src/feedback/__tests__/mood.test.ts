import { MOODS, moodLabel } from '../mood';

describe('MOODS', () => {
  it('covers exactly the 1..5 the column accepts', () => {
    expect(MOODS.map((m) => m.value)).toEqual([1, 2, 3, 4, 5]);
  });

  it('names each one, because a number out of five is a rating and this is not', () => {
    expect(MOODS.every((m) => m.label.length > 0 && m.emoji.length > 0)).toBe(true);
  });
});

describe('moodLabel', () => {
  it('names a stored mood', () => {
    expect(moodLabel(1)).toBe('Broken');
    expect(moodLabel(5)).toBe('Delighted');
  });

  it('is undefined when no mood was given — most reports have none', () => {
    expect(moodLabel(null)).toBeUndefined();
    expect(moodLabel(undefined)).toBeUndefined();
  });

  it('is undefined for a value outside the scale rather than guessing', () => {
    expect(moodLabel(9)).toBeUndefined();
  });
});
