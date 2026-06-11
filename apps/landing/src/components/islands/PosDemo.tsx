/* Mini POS playground — the page's only React island, hydrated on scroll
 * (client:visible). Entirely client-side with mock data: tap items, watch
 * the tab build with service charge + VAT, send tickets to a fake kitchen.
 * Keep this dependency-free; react + react-dom is the page's JS budget. */

import { useRef, useState } from 'react';
import { DEMO_CATEGORIES, DEMO_MENU, formatRs, type DemoItem } from '../../data/demo-menu';
import './pos-demo.css';

type Ticket = {
  id: number;
  lines: { name: string; qty: number; emoji: string }[];
};

const SERVICE_RATE = 0.1;
const VAT_RATE = 0.13;

export default function PosDemo() {
  const [cat, setCat] = useState<(typeof DEMO_CATEGORIES)[number]>(DEMO_CATEGORIES[0]);
  const [lines, setLines] = useState<Record<string, number>>({});
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const ticketNo = useRef(143);

  const items = DEMO_MENU.filter((i) => i.category === cat);
  const ordered = DEMO_MENU.filter((i) => lines[i.id]);

  const subtotal = ordered.reduce((sum, i) => sum + i.price * (lines[i.id] ?? 0), 0);
  const service = subtotal * SERVICE_RATE;
  const vat = (subtotal + service) * VAT_RATE;
  const total = subtotal + service + vat;

  const add = (item: DemoItem) =>
    setLines((l) => ({ ...l, [item.id]: (l[item.id] ?? 0) + 1 }));

  const remove = (item: DemoItem) =>
    setLines((l) => {
      const next = { ...l };
      const qty = (next[item.id] ?? 0) - 1;
      if (qty <= 0) delete next[item.id];
      else next[item.id] = qty;
      return next;
    });

  const send = () => {
    if (!ordered.length) return;
    const ticket: Ticket = {
      id: ticketNo.current++,
      lines: ordered.map((i) => ({ name: i.name, qty: lines[i.id] ?? 0, emoji: i.emoji })),
    };
    setTickets((t) => [ticket, ...t].slice(0, 3));
    setLines({});
  };

  return (
    <div className="pd">
      <div className="pd-menu">
        <div className="pd-cats" role="tablist" aria-label="Menu categories">
          {DEMO_CATEGORIES.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={cat === c}
              className={`pd-cat${cat === c ? ' active' : ''}`}
              onClick={() => setCat(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="pd-grid">
          {items.map((i) => (
            <button key={i.id} className="pd-item" onClick={() => add(i)}>
              <span className="pd-item-emoji" aria-hidden="true">{i.emoji}</span>
              <span className="pd-item-name">
                {i.name}
                {i.popular && <em className="pd-pop">★</em>}
              </span>
              <span className="pd-item-price num">{formatRs(i.price)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="pd-side">
        <div className="pd-tab">
          <div className="pd-tab-head">
            <strong>Table 4 · Guest tab</strong>
            <span className="pill pill-amber">open</span>
          </div>
          {ordered.length === 0 ? (
            <p className="pd-empty">Tap items on the left to start the tab — like your staff would.</p>
          ) : (
            <ul className="pd-lines">
              {ordered.map((i) => (
                <li key={i.id} className="pd-line">
                  <span className="pd-qty">
                    <button onClick={() => remove(i)} aria-label={`Remove one ${i.name}`}>−</button>
                    <span className="num">{lines[i.id]}</span>
                    <button onClick={() => add(i)} aria-label={`Add one ${i.name}`}>+</button>
                  </span>
                  <span className="pd-line-name">{i.name}</span>
                  <span className="leader" />
                  <span className="num">{formatRs(i.price * (lines[i.id] ?? 0))}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="pd-totals">
            <div className="pd-trow"><span>Subtotal</span><span className="num">{formatRs(subtotal)}</span></div>
            <div className="pd-trow"><span>Service 10%</span><span className="num">{formatRs(service)}</span></div>
            <div className="pd-trow"><span>VAT 13%</span><span className="num">{formatRs(vat)}</span></div>
            <div className="pd-trow pd-total"><span>Total</span><span className="num">{formatRs(total)}</span></div>
          </div>
          <div className="pd-actions">
            <button className="btn btn-primary pd-send" onClick={send} disabled={!ordered.length}>
              Send to kitchen
            </button>
            <button className="btn btn-ghost pd-clear" onClick={() => setLines({})} disabled={!ordered.length}>
              Clear
            </button>
          </div>
        </div>

        <div className="pd-kitchen" aria-live="polite">
          <div className="pd-kitchen-head">
            <span className="live-dot" />
            <span>kitchen feed</span>
          </div>
          {tickets.length === 0 ? (
            <p className="pd-kitchen-empty">Tickets you send appear here — instantly, like on the kitchen display.</p>
          ) : (
            tickets.map((t, idx) => (
              <div key={t.id} className={`ticket pd-ticket pd-ticket-${idx}`}>
                <div className="ticket-head">
                  <span>#{t.id} · Table 4</span>
                  <span className="pill pill-lime">new</span>
                </div>
                {t.lines.map((l) => (
                  <div key={l.name} className="ticket-line">
                    <span>
                      {l.qty} × {l.name}
                    </span>
                    <span aria-hidden="true">{l.emoji}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
