import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUIDE_TOPICS, GUIDE_TOPICS_BY_GROUP, ANCHOR_TO_TOPIC } from './content';
import { GUIDE_GROUPS } from './types';
import { TOURS } from './tour/tours';

/* Guards for the written guide.
 *
 * The guide is prose, so most of it can only be checked by reading it. These
 * tests cover the parts that CAN rot silently: a deep link whose anchor no
 * longer exists, a "Try it →" pointing at a route that was renamed, a section
 * that offers a walkthrough that was deleted, and a tour spotlighting an element
 * nobody tags any more.
 *
 * The motivating bug was real: two links on the Findings page pointed at
 * /admin/learn/calculations, which was never a route. Nothing failed. They just
 * fell through to the 404 page for however long nobody clicked them.
 */

const SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const guideSources = walk(join(SRC, 'guide')).map((p) => readFileSync(p, 'utf8'));
const appSource = readFileSync(join(SRC, 'App.tsx'), 'utf8');

/** Every literal `path="…"` in the router, as a set of segments. The admin tree
 *  is nested, so full paths never appear verbatim — checking segment by segment
 *  is what's available, and it's enough: a segment nobody routes on is a 404. */
const routeSegments = new Set(
  [...appSource.matchAll(/path="([^"]+)"/g)]
    .flatMap((m) => m[1]!.split('/'))
    .filter((s) => s && s !== '*' && !s.startsWith(':')),
);

/** Internal links written anywhere in the guide's own prose. */
const guideLinks = guideSources.flatMap((src) =>
  [...src.matchAll(/(?:to|href)="(\/admin[^"#]*)/g)].map((m) => m[1]!),
);

describe('guide structure', () => {
  it('has at least one topic and no empty ones', () => {
    expect(GUIDE_TOPICS.length).toBeGreaterThan(0);
    for (const t of GUIDE_TOPICS) {
      expect(t.sections.length, `topic "${t.id}" has no sections`).toBeGreaterThan(0);
    }
  });

  it('gives every topic a unique id and a known group', () => {
    const ids = GUIDE_TOPICS.map((t) => t.id);
    expect(new Set(ids).size, `duplicate topic ids in ${ids.join(', ')}`).toBe(ids.length);
    for (const t of GUIDE_TOPICS) {
      expect(GUIDE_GROUPS, `topic "${t.id}" has group "${t.group}"`).toContain(t.group);
    }
  });

  it('renders every topic in exactly one rail group', () => {
    const grouped = GUIDE_TOPICS_BY_GROUP.flatMap((g) => g.topics);
    expect(grouped.map((t) => t.id).sort()).toEqual(GUIDE_TOPICS.map((t) => t.id).sort());
  });

  // Section ids become DOM ids and deep-link anchors. A duplicate silently makes
  // one of the two unreachable, and ANCHOR_TO_TOPIC would resolve it to whichever
  // topic happened to be last.
  it('keeps every section id unique across the whole guide', () => {
    const ids = GUIDE_TOPICS.flatMap((t) => t.sections.map((s) => s.id));
    const seen = new Set<string>();
    const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes, `duplicate section ids: ${dupes.join(', ')}`).toEqual([]);
    expect(Object.keys(ANCHOR_TO_TOPIC).length).toBe(ids.length);
  });
});

describe('guide links', () => {
  it('points every internal link at a route that exists', () => {
    expect(guideLinks.length, 'no links found — the scanner is broken').toBeGreaterThan(5);
    const dead = guideLinks.filter((href) =>
      href
        .replace(/^\/admin\/?/, '')
        .split('/')
        .filter(Boolean)
        .some((seg) => !routeSegments.has(seg)),
    );
    expect(dead, `guide links to non-existent routes: ${dead.join(', ')}`).toEqual([]);
  });
});

describe('walkthroughs', () => {
  it('offers only tours that exist', () => {
    const tourIds = new Set(TOURS.map((t) => t.id));
    const referenced = GUIDE_TOPICS.flatMap((t) =>
      t.sections.filter((s) => s.tour).map((s) => ({ section: s.id, tour: s.tour! })),
    );
    for (const r of referenced) {
      expect(tourIds, `section "${r.section}" offers unknown tour "${r.tour}"`).toContain(r.tour);
    }
  });

  it('gives every step something to show', () => {
    for (const tour of TOURS) {
      expect(tour.steps.length, `tour "${tour.id}" has no steps`).toBeGreaterThan(0);
      for (const step of tour.steps) {
        expect(step.title, `a step in "${tour.id}" has no title`).toBeTruthy();
        expect(step.body, `step "${step.title}" has no body`).toBeTruthy();
      }
    }
  });

  it('routes every step at a real route', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (!step.route) continue;
        const bad = step.route
          .replace(/^\/admin\/?/, '')
          .split('/')
          .filter(Boolean)
          .filter((seg) => !routeSegments.has(seg));
        expect(bad, `tour "${tour.id}" step "${step.title}" routes to ${step.route}`).toEqual([]);
      }
    }
  });

  // A spotlight whose target no longer exists degrades to a centred card, which
  // is a graceful failure and therefore an invisible one: the tour still "works"
  // while having stopped pointing at anything.
  it('spotlights elements that are still tagged in the app', () => {
    const pageSources = [...walk(join(SRC, 'pages')), ...walk(join(SRC, 'components'))]
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        if (!step.target) continue;
        const name = /\[data-tour="([^"]+)"\]/.exec(step.target)?.[1];
        expect(name, `unrecognised target selector: ${step.target}`).toBeTruthy();
        expect(
          pageSources.includes(`data-tour="${name}"`),
          `tour "${tour.id}" spotlights data-tour="${name}", which nothing renders`,
        ).toBe(true);
      }
    }
  });
});
