import type { ReactNode } from 'react';

export type TourStep = {
  /**
   * CSS selector for the element to spotlight, e.g. '[data-tour="dash-kpis"]'.
   * If omitted (or the element isn't found), the step shows a centered card.
   */
  target?: string;
  /** Navigate here before showing the step (admin route path). */
  route?: string;
  title: string;
  body: ReactNode;
};

export type Tour = {
  id: string;
  name: string;
  /** One-line description shown in the guide's walkthrough list. */
  blurb: string;
  steps: TourStep[];
};
