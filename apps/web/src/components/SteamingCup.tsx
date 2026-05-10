/* SteamingCup
 *
 * Decorative coffee-cup SVG with three animated steam wisps. Used in the
 * sidebar brand block, login screens, and empty states to give the dark
 * shell a bit of warmth.
 *
 * Two variants:
 *   • inline: compact mark for headers/sidebars
 *   • hero:   larger illustration for empty states
 *
 * Colors follow the live brand tokens (--amber-500 / --ink-*) so the cup
 * recolors with the tenant theme. An optional `emoji` prop lets the
 * tenant accent (☕ 🥐 🍵) sit on top of the cup as a soft mascot.
 */

type Props = {
  size?: number;
  emoji?: string;
  className?: string;
  /** When true, the cup gets a soft shadow halo and larger steam. */
  hero?: boolean;
};

export function SteamingCup({ size = 28, emoji, className, hero = false }: Props) {
  const cls = ['cup', hero ? 'cup-hero' : 'cup-inline', className].filter(Boolean).join(' ');
  return (
    <span className={cls} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="cup-svg"
      >
        {/* steam */}
        <g className="cup-steam" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
          <path className="wisp wisp-1" d="M16 14 C 18 11, 14 9, 16 6" />
          <path className="wisp wisp-2" d="M24 13 C 26 10, 22 8, 24 5" />
          <path className="wisp wisp-3" d="M32 14 C 34 11, 30 9, 32 6" />
        </g>
        {/* saucer */}
        <ellipse cx="24" cy="40" rx="16" ry="2.5" fill="currentColor" opacity="0.18" />
        {/* cup body */}
        <path
          d="M10 18 H34 C34 30 30 38 22 38 C14 38 10 30 10 18 Z"
          fill="currentColor"
          opacity="0.85"
          className="cup-body"
        />
        {/* handle */}
        <path
          d="M34 22 C 40 22, 40 32, 34 32"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
          className="cup-handle"
        />
        {/* coffee surface */}
        <ellipse cx="22" cy="19" rx="11.5" ry="1.6" className="cup-coffee" />
      </svg>
      {emoji && <span className="cup-emoji">{emoji}</span>}
    </span>
  );
}
