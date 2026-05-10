import { useId } from 'react';

const PRESETS = [
  '#FFA319', // amber
  '#A3F02C', // lime
  '#7DD3FC', // sky
  '#F472B6', // pink
  '#C084FC', // violet
  '#FB7185', // rose
  '#34D399', // emerald
  '#94A3B8', // slate
];

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** When the color is empty, what should the swatch fall back to? */
  placeholderColor?: string;
  allowEmpty?: boolean;
};

/** Color picker with a native swatch + preset chips. The hex string is
 * still kept readable so power users can paste a brand color directly. */
export function ColorField({ value, onChange, placeholderColor = '#222127', allowEmpty }: Props) {
  const id = useId();
  const isEmpty = !value;
  const swatchColor = isEmpty ? placeholderColor : value;

  return (
    <div className="cf">
      <label className="cf-swatch" htmlFor={id} style={{ background: swatchColor }}>
        <input
          id={id}
          type="color"
          value={isEmpty ? '#FFA319' : value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
      </label>
      <input
        className="cf-hex"
        type="text"
        value={value}
        placeholder="#FFA319"
        onChange={(e) => onChange(e.target.value)}
      />
      {allowEmpty && !isEmpty && (
        <button type="button" className="cf-clear" onClick={() => onChange('')}>
          clear
        </button>
      )}
      <div className="cf-presets">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p}
            className={`cf-preset ${value.toUpperCase() === p ? 'sel' : ''}`}
            style={{ background: p }}
            onClick={() => onChange(p)}
            title={p}
            aria-label={`use ${p}`}
          />
        ))}
      </div>
    </div>
  );
}
