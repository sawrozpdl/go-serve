import { Link } from 'react-router-dom';

import { useMe } from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { visibleSections } from '@/layout/navConfig';

// A single directory of every section the member can reach — grouped exactly
// like the sidebar (Operations / Catalog / Admin) but with a one-line
// description per page so newcomers can find "where things are" at a glance.
// Driven by the same nav config the sidebar uses, so the two never drift.
export function SitemapPage() {
  const me = useMe();
  const sections = visibleSections(me.data);

  return (
    <PageShell eyebrow="Navigate" title="Site map" subtitle="every section, in one place">
      {sections.map((group) => (
        <section className="sitemap-group" key={group.title}>
          <h3 className="sitemap-group-title">{group.title}</h3>
          <div className="sitemap-grid">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.to} to={item.to} className="sitemap-card">
                  <span className="sitemap-card-icon">
                    <Icon size={18} strokeWidth={1.5} />
                  </span>
                  <span className="sitemap-card-body">
                    <span className="sitemap-card-label">{item.label}</span>
                    <span className="sitemap-card-desc">{item.description}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </PageShell>
  );
}
