import { PERMISSIONS } from '@cafe-mgmt/rbac';
import { describe, expect, it } from 'vitest';

import { KNOWN_FEATURES } from '@/lib/features';

import { unknownExplainerIds } from './framing';
import { ALL_SECTIONS } from './registry';
import { SECTION_GROUPS } from './section';
import { TEMPLATES, templateSelections } from './presets';

const KNOWN_PERMS = new Set(PERMISSIONS.map((p) => p.key));

describe('section registry', () => {
  it('has unique ids', () => {
    const ids = ALL_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a real permission for every gated section', () => {
    // `Permission` looks like a union of manifest keys, but importing a JSON
    // module widens its strings, so tsc accepts any string here. An unknown key
    // makes can() return false and the section silently disappears for everyone
    // — so this has to be checked at test time. (staff:pay got caught this way.)
    const bad = ALL_SECTIONS.filter((s) => s.perm && !KNOWN_PERMS.has(s.perm)).map(
      (s) => `${s.id} -> ${s.perm}`,
    );
    expect(bad).toEqual([]);
  });

  it('names a real plan feature for every gated section', () => {
    const bad = ALL_SECTIONS.filter((s) => s.feature && !KNOWN_FEATURES[s.feature]).map(
      (s) => `${s.id} -> ${s.feature}`,
    );
    expect(bad).toEqual([]);
  });

  it('gates every section on a permission', () => {
    // A report section reads tenant data; one with no perm would be readable by
    // any member regardless of role.
    const ungated = ALL_SECTIONS.filter((s) => !s.perm).map((s) => s.id);
    expect(ungated).toEqual([]);
  });

  it('uses a known group', () => {
    const bad = ALL_SECTIONS.filter((s) => !SECTION_GROUPS.includes(s.group)).map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it('offers its default detail level as a choice', () => {
    const bad = ALL_SECTIONS.filter((s) => !s.detailLevels.includes(s.defaultDetail)).map(
      (s) => `${s.id}: default ${s.defaultDetail} not in [${s.detailLevels.join(', ')}]`,
    );
    expect(bad).toEqual([]);
  });

  it('offers at least one detail level', () => {
    const bad = ALL_SECTIONS.filter((s) => s.detailLevels.length === 0).map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it('bounds any section that defaults to a top-N', () => {
    // topN without a positive cap would render zero rows.
    const bad = ALL_SECTIONS.filter(
      (s) => s.defaultDetail === 'topN' && !s.detailLevels.includes('topN'),
    ).map((s) => s.id);
    expect(bad).toEqual([]);
  });

  it('has a label and a description for the builder', () => {
    const bad = ALL_SECTIONS.filter((s) => !s.label.trim() || !s.description.trim()).map(
      (s) => s.id,
    );
    expect(bad).toEqual([]);
  });

  it('resolves every explainer id it cites', () => {
    // The methodology appendix is generated from guide/explainers.tsx; a stale id
    // means a metric quietly loses its definition in the PDF.
    expect(unknownExplainerIds(ALL_SECTIONS)).toEqual([]);
  });

  it('covers every section family', () => {
    const groups = new Set(ALL_SECTIONS.map((s) => s.group));
    for (const g of SECTION_GROUPS) {
      expect(groups.has(g), `no sections in the ${g} family`).toBe(true);
    }
  });
});

describe('templates', () => {
  it('have unique keys', () => {
    const keys = TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only reference sections that exist', () => {
    const known = new Set(ALL_SECTIONS.map((s) => s.id));
    const bad: string[] = [];
    for (const t of TEMPLATES) {
      for (const sel of templateSelections(t)) {
        if (!known.has(sel.id)) bad.push(`${t.key} -> ${sel.id}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only ask for detail levels the section supports', () => {
    const byId = new Map(ALL_SECTIONS.map((s) => [s.id, s]));
    const bad: string[] = [];
    for (const t of TEMPLATES) {
      for (const sel of templateSelections(t)) {
        const s = byId.get(sel.id);
        if (s && !s.detailLevels.includes(sel.detail)) {
          bad.push(`${t.key} -> ${sel.id}: ${sel.detail}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('list each section at most once', () => {
    const bad: string[] = [];
    for (const t of TEMPLATES) {
      const ids = templateSelections(t).map((s) => s.id);
      if (new Set(ids).size !== ids.length) bad.push(t.key);
    }
    expect(bad).toEqual([]);
  });

  it('include a from-scratch option and at least one populated template', () => {
    expect(TEMPLATES.some((t) => t.sections.length === 0)).toBe(true);
    expect(TEMPLATES.filter((t) => t.sections.length > 0).length).toBeGreaterThan(3);
  });
});
