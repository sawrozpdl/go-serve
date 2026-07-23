/* Testimonials.
 *
 * REAL_TESTIMONIALS is what ships to production — keep it empty until we
 * have genuine, permission-cleared customer quotes. SAMPLE_TESTIMONIALS
 * are placeholders shown ONLY in dev (import.meta.env.DEV) so the design
 * can be validated. They must never render in a production build. */

export type Testimonial = {
  quote: string;
  name: string;
  role: string;
  cafe: string;
  rating?: number;
};

export const REAL_TESTIMONIALS: Testimonial[] = [];

export const SAMPLE_TESTIMONIALS: Testimonial[] = [
  {
    quote:
      'Closing the till used to take half an hour and never matched. Now the day reconciles itself and I actually trust the numbers.',
    name: 'Sample Name',
    role: 'Owner',
    cafe: 'Sample Cafe, Kathmandu',
    rating: 5,
  },
  {
    quote:
      'Orders go straight to the kitchen screen, so nothing gets lost in the Dashain rush. The staff picked it up in a day.',
    name: 'Sample Name',
    role: 'Manager',
    cafe: 'Sample Roastery, Pokhara',
    rating: 5,
  },
  {
    quote:
      'Being able to see profit by category finally told me which drinks were actually making money. That changed my menu.',
    name: 'Sample Name',
    role: 'Owner',
    cafe: 'Sample Bistro, Lalitpur',
    rating: 5,
  },
];
