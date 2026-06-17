import { ChevronRight } from 'lucide-react';

type Props = {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
};

/**
 * A lightweight expand/collapse built on native <details>, so it works without
 * JS state and stays accessible. Used for "show me more" subsections in the
 * GoServe Training guide.
 */
export function Collapsible({ title, children, defaultOpen = false }: Props) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary className="collapsible__summary">
        <ChevronRight size={14} strokeWidth={1.8} className="collapsible__chev" aria-hidden />
        <span>{title}</span>
      </summary>
      <div className="collapsible__body">{children}</div>
    </details>
  );
}
