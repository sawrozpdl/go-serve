import { PageShell } from '@/components/PageShell';
import { MoneyFlowSim } from '@/guide/money/MoneyFlowSim';

/** An interactive sandbox that shows where the cafe's money lives and what
 *  moves the balance. Ungated learning material, like the GoServe guide. */
export function MoneyFlowPage() {
  return (
    <PageShell
      eyebrow="Learn · Sandbox"
      title="Money flow (demo)"
      subtitle="where your money lives — and what actually moves the balance"
    >
      <div className="banner-info" style={{ marginBottom: 16 }}>
        This is a practice sandbox. The numbers here are made up — nothing on this
        page touches your real cafe data, drawer, or balances.
      </div>
      <MoneyFlowSim />
    </PageShell>
  );
}
