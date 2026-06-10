import type { ReactNode } from 'react';

import { useMe, hasFeature } from '@/lib/api';
import { UpgradePrompt } from './UpgradePrompt';

// Render-gate analogous to <Can>: shows `children` only when the active
// tenant's plan includes `feature`. While /me is still loading we render
// nothing (avoids flashing an upgrade prompt for a feature the tenant has).
// Defaults the fallback to an <UpgradePrompt> for the feature.
export function FeatureGate({
  feature,
  children,
  fallback,
}: {
  feature: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const me = useMe();
  if (me.isPending) return null;
  if (hasFeature(me.data, feature)) return <>{children}</>;
  return <>{fallback ?? <UpgradePrompt feature={feature} />}</>;
}
