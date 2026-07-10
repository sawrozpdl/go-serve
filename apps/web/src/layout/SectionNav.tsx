import { createContext, useContext, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Tabs } from '@/components/Tabs';

// A grouped "section" (People, Reports, …) merges several routes under one
// sidebar entry. Its layout publishes a sub-navigation strip here; PageShell
// reads it and renders it under the page header, so every child page picks up
// the section tabs without any per-page wiring.
export const SectionNavContext = createContext<ReactNode>(null);

export function useSectionNav(): ReactNode {
  return useContext(SectionNavContext);
}

export type SectionTabItem = { to: string; label: ReactNode; icon?: ReactNode };

/** Route-driven tab strip: the active tab is whichever item's `to` prefixes the
 *  current path; selecting one navigates there. */
export function SectionTabs({ items }: { items: SectionTabItem[] }) {
  const loc = useLocation();
  const nav = useNavigate();
  const first = items[0];
  if (!first) return null;
  const active = items.find((i) => loc.pathname === i.to || loc.pathname.startsWith(i.to + '/'))?.to ?? first.to;
  return (
    <Tabs
      items={items.map((i) => ({ key: i.to, label: i.label, icon: i.icon }))}
      active={active}
      onChange={(k) => nav(k)}
      ariaLabel="Section"
    />
  );
}
