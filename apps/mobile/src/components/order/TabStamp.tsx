/**
 * TabStamp — renders a derived tab state (`deriveTabState`) as a Docket stamp.
 * Maps the api-types tone buckets onto the theme's stamp tones: `action` (the
 * server/cashier's turn) is the brand highlight; the rest map by name.
 */
import type { StampTone } from '@cafe-mgmt/design-tokens';
import type { TabState } from '@cafe-mgmt/api-types';
import { Stamp } from '@/components/ui/Stamp';

const TONE: Record<TabState['tone'], StampTone> = {
  neutral: 'neutral',
  info: 'info',
  warn: 'warn',
  action: 'brand',
  success: 'success',
};

export function TabStamp({ state, size = 'sm' }: { state: TabState; size?: 'sm' | 'md' }) {
  return <Stamp label={state.label} tone={TONE[state.tone]} size={size} />;
}
