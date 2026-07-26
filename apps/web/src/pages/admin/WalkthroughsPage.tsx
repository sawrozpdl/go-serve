import { Play } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { TOURS } from '@/guide/tour/tours';
import { useTour } from '@/guide/tour/TourProvider';

/** Launcher for the guided walkthroughs. The tours themselves run as an overlay
 *  on the real pages — starting one navigates away from here, which is the
 *  point: you learn on the actual screens, with your own cafe in front of you. */
export function WalkthroughsPage() {
  const { startTour } = useTour();

  return (
    <PageShell
      eyebrow="Learn"
      title="Walkthroughs"
      subtitle="guided tours of the real screens, step by step"
      docTitle="Walkthroughs"
    >
      <div className="banner-info" style={{ marginBottom: 16 }}>
        A walkthrough takes over the screen and points at the real controls as you go.
        Nothing is saved or sent on your behalf — you can stop at any step with{' '}
        <kbd>Esc</kbd>.
      </div>

      <div className="tour-grid">
        {TOURS.map((tour) => (
          <article className="tour-card" key={tour.id}>
            <div className="tour-card__body">
              <h3 className="tour-card__title">{tour.name}</h3>
              <p className="tour-card__blurb">{tour.blurb}</p>
              <p className="tour-card__meta">
                {tour.steps.length} step{tour.steps.length === 1 ? '' : 's'}
              </p>
            </div>
            <button type="button" className="btn" onClick={() => startTour(tour.id)}>
              <Play size={13} strokeWidth={1.8} aria-hidden /> Start
            </button>
          </article>
        ))}
      </div>
    </PageShell>
  );
}
