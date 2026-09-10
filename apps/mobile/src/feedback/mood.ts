/**
 * The five moods a report can carry.
 *
 * Stored as 1..5 because that is what the column takes; shown as words
 * because a number out of five is a rating and this is not one. "Broken" and
 * "Delighted" are different KINDS of message, not two ends of a satisfaction
 * scale, and triage acts on them differently.
 */
export type Mood = { value: number; label: string; emoji: string };

export const MOODS: Mood[] = [
  { value: 1, label: 'Broken', emoji: '😠' },
  { value: 2, label: 'Annoying', emoji: '🙁' },
  { value: 3, label: 'Neutral', emoji: '😐' },
  { value: 4, label: 'Good', emoji: '🙂' },
  { value: 5, label: 'Delighted', emoji: '😄' },
];

export function moodLabel(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return MOODS.find((m) => m.value === value)?.label;
}
