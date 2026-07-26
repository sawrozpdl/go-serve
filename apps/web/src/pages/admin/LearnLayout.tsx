import { BookOpen, Calculator, Coins, Compass, Play } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { SectionNavContext, SectionTabs, type SectionTabItem } from '@/layout/SectionNav';

/* Learn — one home for everything explanatory.
 *
 * These five surfaces grew separately (a guide, a money sandbox, a tour list, a
 * site map) and ended up as separate sidebar entries a new operator had to
 * discover one at a time. They're now tabs of one section: no permission gates,
 * because none of it reads cafe-specific data except "How the numbers work",
 * which gates each figure individually.
 */
const LEARN_TABS: SectionTabItem[] = [
  {
    to: '/admin/learn/numbers',
    label: 'How the numbers work',
    icon: <Calculator size={12} strokeWidth={1.6} />,
  },
  { to: '/admin/learn/guide', label: 'Guide', icon: <BookOpen size={12} strokeWidth={1.6} /> },
  {
    to: '/admin/learn/walkthroughs',
    label: 'Walkthroughs',
    icon: <Play size={12} strokeWidth={1.6} />,
  },
  {
    to: '/admin/learn/money-flow',
    label: 'Money flow',
    icon: <Coins size={12} strokeWidth={1.6} />,
  },
  { to: '/admin/learn/map', label: 'Site map', icon: <Compass size={12} strokeWidth={1.6} /> },
];

export function LearnLayout() {
  return (
    <SectionNavContext.Provider value={<SectionTabs items={LEARN_TABS} />}>
      <Outlet />
    </SectionNavContext.Provider>
  );
}

/** /admin/learn → the calculations tab, the most-asked-for of the five. */
export function LearnIndex() {
  return <Navigate to="/admin/learn/numbers" replace />;
}

/* Legacy path redirects.
 *
 * The old routes are kept because "Learn more →" links, bookmarks and the
 * printed guide all point at them. React Router's <Navigate to="/x"> drops the
 * hash, which would silently break every metric deep link — so the hash is
 * carried over explicitly.
 *
 * Metric anchors (#metric-sales) belong to the calculations tab now; every other
 * anchor is a guide section and stays with the guide.
 */
export function LegacyGuideRedirect() {
  const { hash } = useLocation();
  const anchor = hash.replace(/^#/, '');
  const tab = anchor.startsWith('metric-') ? 'numbers' : 'guide';
  return <Navigate to={`/admin/learn/${tab}${hash}`} replace />;
}

/** One-line redirect for the other two folded-in paths, hash preserved. */
export function LegacyLearnRedirect({ tab }: { tab: 'money-flow' | 'map' }) {
  const { hash } = useLocation();
  return <Navigate to={`/admin/learn/${tab}${hash}`} replace />;
}
