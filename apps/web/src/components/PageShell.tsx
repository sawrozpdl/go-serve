import { useEffect, type ReactNode } from 'react';

import { useSectionNav } from '@/layout/SectionNav';

type Props = {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Browser-tab title. Defaults to `title` when it's a plain string. */
  docTitle?: string;
};

/** Every admin page's outer frame.
 *  - Sticky header (eyebrow + h1 + actions).
 *  - Optional sticky tab strip below the header.
 *  - Body region that scrolls internally so the header stays put.
 *  - Optional sticky footer (e.g. save bar) that sits OUTSIDE the scroll
 *    region — content never slips beneath it.
 *  - Sets the document title ("Floor · GoServe") so multi-tab operators can
 *    tell pages apart. */
export function PageShell({
  eyebrow,
  title,
  subtitle,
  actions,
  tabs,
  footer,
  children,
  className,
  docTitle,
}: Props) {
  const sectionNav = useSectionNav();
  const tabTitle = docTitle ?? (typeof title === 'string' ? title : undefined);
  useEffect(() => {
    if (!tabTitle) return;
    const prev = document.title;
    document.title = `${tabTitle} · GoServe`;
    return () => {
      document.title = prev;
    };
  }, [tabTitle]);

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
      {sectionNav && <div className="page-shell__section-nav">{sectionNav}</div>}
      {tabs && <div className="page-shell__tabs">{tabs}</div>}
      <div className="page-shell__body">{children}</div>
      {footer && <div className="page-shell__footer">{footer}</div>}
    </div>
  );
}
