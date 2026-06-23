import { PageShell } from '@/components/PageShell';
import { MoneyFlowSim } from '@/guide/money/MoneyFlowSim';

/** An interactive sandbox that shows where the cafe's money lives and what
 *  moves the balance. Ungated learning material, like the GoServe guide. */
export function MoneyFlowPage() {
  return (
    <PageShell
      eyebrow="Learn"
      title="Money flow"
      subtitle="where your money lives — and what actually moves the balance"
    >
      <MoneyFlowSim />
    </PageShell>
  );
}
