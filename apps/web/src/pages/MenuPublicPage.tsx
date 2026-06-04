import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { UtensilsCrossed } from 'lucide-react';

import { brandingToCss, type TenantBranding } from '@cafe-mgmt/design-tokens';

import { formatNPR } from '@/components/Money';
import { getIconComponent } from '@/components/icons';
import { usePublicMenu, type PublicMenuCategory, type PublicMenuItem } from '@/lib/public';
import '@/styles/menu-public.css';

// Customer-facing menu reached by scanning a desk QR (/menu/:slug). It is a
// self-contained, public surface: no auth, no app chrome, and deliberately NO
// links into the staff app. A guest can only read the menu.
export default function MenuPublicPage() {
  const { slug } = useParams<{ slug: string }>();
  const menu = usePublicMenu(slug);

  const cafe = menu.data?.cafe;
  const categories = menu.data?.categories ?? [];

  // Tab title = the cafe name, so a shared link / browser tab reads nicely.
  useEffect(() => {
    if (cafe?.name) document.title = `${cafe.name} · Menu`;
    return () => {
      document.title = 'GoServe';
    };
  }, [cafe?.name]);

  // Translate the cafe's brand colors into the CSS variables the page consumes.
  const brandCss = useMemo(
    // The public branding is a structural subset of TenantBranding (colors +
    // mood/typography labels); brandingToCss only reads the color keys.
    () => (cafe?.branding ? brandingToCss(cafe.branding as TenantBranding) : ''),
    [cafe?.branding],
  );

  // --- Loading / error states ------------------------------------------
  if (menu.isPending) {
    return (
      <div className="menu-pub menu-pub--center">
        <div className="menu-pub__spinner" aria-label="Loading menu" />
      </div>
    );
  }
  if (menu.isError) {
    const notFound = menu.error.status === 404;
    return (
      <div className="menu-pub menu-pub--center">
        <div className="menu-pub__notice">
          <UtensilsCrossed size={40} strokeWidth={1.25} />
          <h1>{notFound ? 'Menu not found' : 'Something went wrong'}</h1>
          <p>
            {notFound
              ? "We couldn't find a menu at this link. Please check the code on your table or ask our staff."
              : 'The menu is temporarily unavailable. Please try again in a moment.'}
          </p>
        </div>
      </div>
    );
  }
  if (!cafe) return null;

  return (
    <div className="menu-pub">
      {brandCss && <style>{brandCss}</style>}

      <Hero cafe={cafe} />

      {categories.length > 0 && <CategoryNav categories={categories} />}

      <main className="menu-pub__body">
        {categories.length === 0 ? (
          <div className="menu-pub__empty">
            <UtensilsCrossed size={32} strokeWidth={1.25} />
            <p>Our menu is being updated. Please ask our staff for today's offerings.</p>
          </div>
        ) : (
          categories.map((c) => <Section key={c.id} category={c} />)
        )}
      </main>

      <Footer cafe={cafe} />
    </div>
  );
}

function Hero({ cafe }: { cafe: NonNullable<ReturnType<typeof usePublicMenu>['data']>['cafe'] }) {
  return (
    <header className="menu-pub__hero">
      <div className="menu-pub__mark">
        {cafe.logo_url ? (
          <img src={cafe.logo_url} alt={cafe.name} className="menu-pub__logo" />
        ) : cafe.accent_emoji ? (
          <span className="menu-pub__emoji" aria-hidden>
            {cafe.accent_emoji}
          </span>
        ) : null}
      </div>
      <span className="menu-pub__eyebrow">Menu</span>
      <h1 className="menu-pub__name">{cafe.name}</h1>
      {cafe.tagline && <p className="menu-pub__tagline">{cafe.tagline}</p>}
    </header>
  );
}

// Sticky, horizontally-scrollable category chips. Tapping a chip scrolls to
// its section; an IntersectionObserver keeps the active chip in sync as the
// guest scrolls.
function CategoryNav({ categories }: { categories: PublicMenuCategory[] }) {
  const [active, setActive] = useState<string>(categories[0]?.id ?? '');
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sections = categories
      .map((c) => document.getElementById(`cat-${c.id}`))
      .filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActive(visible[0].target.id.replace('cat-', ''));
        }
      },
      // Bias the trigger line a bit below the sticky nav so the chip flips
      // when a section reaches reading position, not the very top.
      { rootMargin: '-96px 0px -65% 0px', threshold: 0 },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [categories]);

  // Keep the active chip scrolled into view within the nav strip.
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-chip="${active}"]`);
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const onJump = (id: string) => {
    const el = document.getElementById(`cat-${id}`);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <nav className="menu-pub__nav" aria-label="Menu categories">
      <div className="menu-pub__nav-strip" ref={navRef}>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            data-chip={c.id}
            className={`menu-pub__chip${active === c.id ? ' is-active' : ''}`}
            onClick={() => onJump(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
    </nav>
  );
}

function Section({ category }: { category: PublicMenuCategory }) {
  const Icon = getIconComponent(category.icon);
  const hasItemPhoto = category.items.some((it) => !!it.image_url);
  return (
    <section className="menu-pub__section" id={`cat-${category.id}`}>
      {category.image_url ? (
        <div className="menu-pub__banner">
          <img src={category.image_url} alt={category.name} loading="lazy" />
          <div className="menu-pub__banner-label">
            {Icon && <Icon size={18} strokeWidth={1.75} />}
            <h2>{category.name}</h2>
          </div>
        </div>
      ) : (
        <div className="menu-pub__section-head">
          {Icon && (
            <span className="menu-pub__cat-icon" style={category.color ? { color: category.color } : undefined}>
              <Icon size={20} strokeWidth={1.5} />
            </span>
          )}
          <h2>{category.name}</h2>
        </div>
      )}
      <ul className={`menu-pub__items${hasItemPhoto ? ' menu-pub__items--cards' : ''}`}>
        {category.items.map((it) => (
          <ItemRow key={it.id} item={it} withPhoto={hasItemPhoto} />
        ))}
      </ul>
    </section>
  );
}

function ItemRow({ item, withPhoto }: { item: PublicMenuItem; withPhoto: boolean }) {
  // Card layout: used when at least one item in the section has a photo, so
  // the whole section reads as a consistent grid of cards.
  if (withPhoto) {
    const Icon = getIconComponent(item.icon);
    return (
      <li className="menu-pub__card">
        <div className="menu-pub__card-media">
          {item.image_url ? (
            <img src={item.image_url} alt={item.name} loading="lazy" />
          ) : (
            <span className="menu-pub__card-ph" aria-hidden>
              {Icon ? <Icon size={26} strokeWidth={1.25} /> : null}
            </span>
          )}
          {item.is_featured && <span className="menu-pub__badge menu-pub__badge--float">★ Popular</span>}
        </div>
        <div className="menu-pub__card-body">
          <h3 className="menu-pub__item-name">{item.name}</h3>
          {item.description && <p className="menu-pub__desc">{item.description}</p>}
          <span className="menu-pub__price">{formatNPR(item.price_cents)}</span>
        </div>
      </li>
    );
  }

  // Classic dotted-leader list row for text-only sections.
  return (
    <li className="menu-pub__item">
      <div className="menu-pub__item-main">
        <div className="menu-pub__item-top">
          <h3 className="menu-pub__item-name">
            {item.name}
            {item.is_featured && <span className="menu-pub__badge">★ Popular</span>}
          </h3>
          <span className="menu-pub__dots" aria-hidden />
          <span className="menu-pub__price">{formatNPR(item.price_cents)}</span>
        </div>
        {item.description && <p className="menu-pub__desc">{item.description}</p>}
      </div>
    </li>
  );
}

function Footer({ cafe }: { cafe: NonNullable<ReturnType<typeof usePublicMenu>['data']>['cafe'] }) {
  const vat = parseFloat(cafe.vat_pct);
  const svc = parseFloat(cafe.service_charge_pct);
  const parts: string[] = [];
  if (Number.isFinite(vat) && vat > 0) parts.push(`${trimPct(vat)}% VAT`);
  if (Number.isFinite(svc) && svc > 0) parts.push(`${trimPct(svc)}% service charge`);

  return (
    <footer className="menu-pub__footer">
      <p className="menu-pub__fine">
        Prices in Nepalese Rupees (NPR).
        {parts.length > 0 && ` ${parts.join(' and ')} applied at billing.`}
      </p>
      <p className="menu-pub__fine menu-pub__fine--muted">{cafe.name}</p>
    </footer>
  );
}

// "13.00" → "13", "12.50" → "12.5"
function trimPct(n: number): string {
  return String(Math.round(n * 100) / 100);
}
