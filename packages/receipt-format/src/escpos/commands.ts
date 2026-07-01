// Raw ESC/POS byte constants. All values are plain number arrays so the
// builder can concatenate them into a single buffer without allocation churn.
export const CMD = {
  INIT: [0x1b, 0x40] as const, // ESC @
  LF: [0x0a] as const,
  ALIGN_LEFT: [0x1b, 0x61, 0x00] as const,
  ALIGN_CENTER: [0x1b, 0x61, 0x01] as const,
  ALIGN_RIGHT: [0x1b, 0x61, 0x02] as const,
  BOLD_ON: [0x1b, 0x45, 0x01] as const,
  BOLD_OFF: [0x1b, 0x45, 0x00] as const,
  DOUBLE_ON: [0x1d, 0x21, 0x11] as const, // double height + width
  DOUBLE_OFF: [0x1d, 0x21, 0x00] as const,
  CUT: [0x1d, 0x56, 0x01] as const, // partial cut
  FEED_AND_CUT: [0x1d, 0x56, 0x42, 0x03] as const, // feed 3 then cut
  SELECT_CP437: [0x1b, 0x74, 0x00] as const, // codepage select
} as const;
