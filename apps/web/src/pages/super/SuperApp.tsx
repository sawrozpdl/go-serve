import { Routes, Route, Navigate } from 'react-router-dom';

import { SuperShell } from '@/layout/SuperShell';
import { SuperTenantsPage } from './SuperTenantsPage';
import { SuperTenantDetailPage } from './SuperTenantDetailPage';
import { SuperRequestsPage } from './SuperRequestsPage';
import { SuperPlansPage } from './SuperPlansPage';
import { SuperAdminsPage } from './SuperAdminsPage';
import { SuperAuditPage } from './SuperAuditPage';

// Nested routing for the super-admin console. Mounted lazily under /super/* so
// the (rarely used) cross-tenant console never weighs down the tenant bundle.
export default function SuperApp() {
  return (
    <Routes>
      <Route element={<SuperShell />}>
        <Route index element={<Navigate to="tenants" replace />} />
        <Route path="tenants" element={<SuperTenantsPage />} />
        <Route path="tenants/:id" element={<SuperTenantDetailPage />} />
        <Route path="requests" element={<SuperRequestsPage />} />
        <Route path="plans" element={<SuperPlansPage />} />
        <Route path="admins" element={<SuperAdminsPage />} />
        <Route path="audit" element={<SuperAuditPage />} />
        <Route path="*" element={<Navigate to="tenants" replace />} />
      </Route>
    </Routes>
  );
}
