import { Routes, Route, Navigate } from 'react-router-dom';

import { SuperShell } from '@/layout/SuperShell';
import { SUPER_NAV, SUPER_HOME } from '@/layout/superNavConfig';

// Nested routing for the super-admin console. Mounted lazily under /super/* so
// the (rarely used) cross-tenant console never weighs down the tenant bundle.
//
// Routes are generated from SUPER_NAV — the same list the shell's top bar
// renders — so a section can never exist as a route with no way to reach it,
// or as a nav link that 404s.
export default function SuperApp() {
  return (
    <Routes>
      <Route element={<SuperShell />}>
        <Route index element={<Navigate to={SUPER_HOME} replace />} />
        {SUPER_NAV.flatMap(({ path, Page, children }) => [
          <Route key={path} path={path} element={<Page />} />,
          ...(children ?? []).map((c) => <Route key={c.path} path={c.path} element={<c.Page />} />),
        ])}
        <Route path="*" element={<Navigate to={SUPER_HOME} replace />} />
      </Route>
    </Routes>
  );
}
