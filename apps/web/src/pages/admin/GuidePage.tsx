import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Play } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { SearchInput } from '@/components/SearchInput';
import { EmptyState } from '@/components/EmptyState';
import { GUIDE_TOPICS, ANCHOR_TO_TOPIC, type GuideTopic } from '@/guide/content';
import { useTour } from '@/guide/tour/TourProvider';

function scrollToAnchor(anchor: string) {
  requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

export function GuidePage() {
  const [activeId, setActiveId] = useState(GUIDE_TOPICS[0]!.id);
  const [query, setQuery] = useState('');
  const { startTour } = useTour();
  const { hash } = useLocation();

  // Deep links from tooltips ("Learn more →") arrive as /admin/guide#<anchor>.
  useEffect(() => {
    const anchor = hash.replace(/^#/, '');
    if (!anchor) return;
    const topicId = ANCHOR_TO_TOPIC[anchor];
    if (topicId) {
      setQuery('');
      setActiveId(topicId);
      scrollToAnchor(anchor);
    }
  }, [hash]);

  const q = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!q) return [];
    return GUIDE_TOPICS.flatMap((t) =>
      t.sections
        .filter((s) => `${t.title} ${t.blurb} ${s.heading}`.toLowerCase().includes(q))
        .map((s) => ({ topic: t, section: s })),
    );
  }, [q]);

  const active = GUIDE_TOPICS.find((t) => t.id === activeId) ?? GUIDE_TOPICS[0]!;

  const openSection = (topicId: string, anchor: string) => {
    setQuery('');
    setActiveId(topicId);
    scrollToAnchor(anchor);
  };

  return (
    <PageShell
      eyebrow="Learn"
      title="GoServe Training"
      subtitle="how to use GoServe — and how every number is calculated"
      actions={
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search the guide…"
          minWidth={220}
        />
      }
    >
      <div className="guide-layout">
        <nav className="guide-rail" aria-label="Guide topics">
          {GUIDE_TOPICS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                className={`guide-rail-item${!q && t.id === active.id ? ' active' : ''}`}
                onClick={() => {
                  setQuery('');
                  setActiveId(t.id);
                  scrollToAnchor(t.sections[0]!.id);
                }}
              >
                <Icon size={15} strokeWidth={1.6} />
                <span>{t.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="guide-article">
          {q ? (
            <div className="guide-results">
              <p className="guide-muted">
                {matches.length} result{matches.length === 1 ? '' : 's'} for “{query}”
              </p>
              {matches.map(({ topic, section }) => (
                <button
                  key={`${topic.id}-${section.id}`}
                  type="button"
                  className="guide-result"
                  onClick={() => openSection(topic.id, section.id)}
                >
                  <span className="guide-result-topic">{topic.title}</span>
                  <span className="guide-result-heading">{section.heading}</span>
                </button>
              ))}
              {matches.length === 0 && (
                <EmptyState
                  compact
                  title="No matches"
                  hint="Try a different word, or browse the topics on the left."
                />
              )}
            </div>
          ) : (
            <TopicView topic={active} onStartTour={startTour} />
          )}
        </div>
      </div>
    </PageShell>
  );
}

function TopicView({
  topic,
  onStartTour,
}: {
  topic: GuideTopic;
  onStartTour: (id: string) => void;
}) {
  return (
    <article className="guide-topic">
      <h2 className="guide-topic-title">{topic.title}</h2>
      {topic.sections.map((s) => (
        <section key={s.id} id={s.id} className="guide-section">
          <h3 className="guide-section-h">{s.heading}</h3>
          <div className="guide-section-body">{s.body}</div>
          {s.tour && (
            <button type="button" className="btn guide-tour-btn" onClick={() => onStartTour(s.tour!)}>
              <Play size={13} strokeWidth={1.8} /> Start walkthrough
            </button>
          )}
        </section>
      ))}
    </article>
  );
}
