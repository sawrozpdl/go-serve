import { useState } from 'react';

export type ShotPin = {
  /** Horizontal position as a percentage of the image width (0–100). */
  x: number;
  /** Vertical position as a percentage of the image height (0–100). */
  y: number;
  /** What this callout points at. */
  label: string;
};

type Props = {
  /** Image path under /public/guide, e.g. "/guide/floor.png". */
  src: string;
  alt: string;
  caption?: string;
  pins?: ShotPin[];
};

/**
 * A screenshot with numbered callout pins and a matching legend. If the image
 * is missing (not yet captured), it degrades to a labelled placeholder so the
 * guide still reads cleanly — the legend always renders the step text.
 */
export function AnnotatedShot({ src, alt, caption, pins = [] }: Props) {
  const [failed, setFailed] = useState(false);

  return (
    <figure className="ashot">
      <div className="ashot__frame">
        {!failed ? (
          <img
            className="ashot__img"
            src={src}
            alt={alt}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="ashot__placeholder">
            <span>{alt}</span>
            <small>screenshot coming soon</small>
          </div>
        )}
        {!failed &&
          pins.map((p, i) => (
            <span
              key={i}
              className="ashot__pin"
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              aria-hidden
            >
              {i + 1}
            </span>
          ))}
      </div>
      {(caption || pins.length > 0) && (
        <figcaption className="ashot__cap">
          {caption && <span className="ashot__caption-text">{caption}</span>}
          {pins.length > 0 && (
            <ol className="ashot__legend">
              {pins.map((p, i) => (
                <li key={i}>
                  <span className="ashot__legend-n">{i + 1}</span>
                  {p.label}
                </li>
              ))}
            </ol>
          )}
        </figcaption>
      )}
    </figure>
  );
}
