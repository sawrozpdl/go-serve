import { type ReactNode } from 'react';

type Props = {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Every admin page's outer frame.
 *  - Sticky header (eyebrow + h1 + actions).
 *  - Optional sticky tab strip below the header.
 *  - Body region that scrolls internally so the header stays put.
 *  - Optional sticky footer (e.g. save bar) that sits OUTSIDE the scroll
 *    region — content never slips beneath it. */
export function PageShell({
  eyebrow,
  title,
  subtitle,
  actions,
  tabs,
  footer,
  children,
  className,
}: Props) {
  return (
    <div className={`page-shell${className ? ` ${className}` : ''}`}>
      <header className="page-shell__header">
        <div className="page-shell__title">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
          {subtitle && <div className="page-shell__sub">{subtitle}</div>}
        </div>
        {actions && <div className="page-shell__actions">{actions}</div>}
      </header>
      {tabs && <div className="page-shell__tabs">{tabs}</div>}
      <div className="page-shell__body">{children}</div>
      {footer && <div className="page-shell__footer">{footer}</div>}
    </div>
  );
}
