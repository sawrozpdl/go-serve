import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowLeft, Copy, Download, Printer, ExternalLink, Check } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { printHTML } from '@/lib/printing';
import {
  DEFAULT_QR_CARD_ID,
  QR_CARD_TEMPLATES,
  qrCardTemplate,
} from '@/lib/qrCardTemplates';
import { toast } from '@/lib/toast';

// Remembers the cafe's preferred card design across sessions.
const TEMPLATE_KEY = 'cafe.qrCardTemplate';

type Props = {
  slug: string;
  /** Cafe display name — used on the printable table tent. */
  cafeName?: string;
  open: boolean;
  onClose: () => void;
};

// Reliable scannability beats brand color here: a high-contrast dark-on-white
// code reads from across a noisy cafe. We theme the page, not the code.
const QR_OPTS = { margin: 1, color: { dark: '#1a1a1a', light: '#ffffff' } } as const;

// Lets the owner grab the public menu URL + a downloadable/printable QR to
// stand on desks. The QR encodes the same /menu/:slug link the staff app
// serves publicly — nothing here exposes the admin app.
//
// The QR is rendered as a data-URL <img> (never injected as markup), so no
// generated string ever reaches innerHTML.
export function PublicMenuShareModal({ slug, cafeName, open, onClose }: Props) {
  const url = `${window.location.origin}/menu/${slug}`;
  const title = cafeName || 'Our Menu';
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  // 'share' is the link/QR landing view; 'print' is the design gallery shown
  // just before printing.
  const [view, setView] = useState<'share' | 'print'>('share');
  const [templateId, setTemplateId] = useState<string>(() => {
    try {
      return localStorage.getItem(TEMPLATE_KEY) || DEFAULT_QR_CARD_ID;
    } catch {
      return DEFAULT_QR_CARD_ID;
    }
  });

  // Always land back on the share view when the modal is dismissed, so the
  // gallery isn't still showing the next time it opens.
  useEffect(() => {
    if (!open) setView('share');
  }, [open]);

  const selectTemplate = (id: string) => {
    setTemplateId(id);
    try {
      localStorage.setItem(TEMPLATE_KEY, id);
    } catch {
      // private mode / storage disabled — the choice just won't persist
    }
  };

  // Live, true-to-print previews: render each template's actual document into a
  // scaled iframe. Rebuilt only when the inputs change (not on every keystroke /
  // re-render). Empty until the QR is ready.
  const previews = useMemo(
    () =>
      QR_CARD_TEMPLATES.map((t) => ({
        template: t,
        html: qrDataUrl ? t.render({ title, url, qrDataUrl }) : '',
      })),
    [title, url, qrDataUrl],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 480px source displayed at 240 keeps the code crisp on retina tablets.
    QRCode.toDataURL(url, { ...QR_OPTS, width: 480 })
      .then((d) => {
        if (!cancelled) setQrDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast.success('Link copied', 'Paste it anywhere to share your menu.');
    } catch {
      toast.error('Could not copy', 'Select the link and copy it manually.');
    }
  };

  const downloadPng = async () => {
    try {
      const dataUrl = await QRCode.toDataURL(url, { ...QR_OPTS, width: 1024, margin: 2 });
      triggerDownload(dataUrl, `${slug}-menu-qr.png`);
    } catch {
      toast.error('Download failed', 'Could not generate the PNG.');
    }
  };

  const downloadSvg = async () => {
    try {
      const svg = await QRCode.toString(url, { ...QR_OPTS, type: 'svg', width: 240 });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const objectUrl = URL.createObjectURL(blob);
      triggerDownload(objectUrl, `${slug}-menu-qr.svg`);
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast.error('Download failed', 'Could not generate the SVG.');
    }
  };

  // Print the chosen design. We regenerate the QR at high resolution (the
  // previews use the lighter on-screen one) and hand the template's document to
  // printHTML — a hidden iframe (see lib/printing), not a popup: popups get
  // blocked, and a popup's inline auto-print <script> is refused by our
  // `script-src 'self'` CSP, which is what left the old popup blank.
  const printSelected = async () => {
    let printQr = qrDataUrl;
    try {
      printQr = await QRCode.toDataURL(url, { ...QR_OPTS, width: 1024, margin: 2 });
    } catch {
      // fall back to the on-screen resolution
    }
    if (!printQr) {
      toast.error('Nothing to print', 'The QR code is still generating — try again in a moment.');
      return;
    }
    printHTML(qrCardTemplate(templateId).render({ title, url, qrDataUrl: printQr }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Public menu"
      subtitle={
        view === 'print'
          ? 'Pick a design, then print'
          : 'Share or print a QR for your guests'
      }
    >
      {view === 'print' ? (
        <div className="qr-tpl">
          <button type="button" className="qr-tpl-back" onClick={() => setView('share')}>
            <ArrowLeft size={14} /> Back to sharing
          </button>

          <div className="qr-tpl-grid" role="radiogroup" aria-label="QR card design">
            {previews.map(({ template, html }) => {
              const on = template.id === templateId;
              return (
                <button
                  key={template.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`qr-tpl-card${on ? ' on' : ''}`}
                  onClick={() => selectTemplate(template.id)}
                >
                  <span className="qr-tpl-thumb">
                    {html ? (
                      <iframe
                        className="qr-tpl-frame"
                        title={`${template.name} preview`}
                        srcDoc={html}
                        sandbox=""
                        tabIndex={-1}
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="qr-tpl-thumb-empty">Generating…</span>
                    )}
                    {on && (
                      <span className="qr-tpl-check" aria-hidden="true">
                        <Check size={13} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span className="qr-tpl-name">{template.name}</span>
                </button>
              );
            })}
          </div>

          <div className="qr-tpl-actions">
            <button type="button" className="btn small" onClick={() => setView('share')}>
              Back
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={printSelected}
              disabled={!qrDataUrl}
            >
              <Printer size={14} /> Print this design
            </button>
          </div>
        </div>
      ) : (
        <div className="qr-share">
          <p className="field-hint" style={{ marginTop: 0 }}>
            Guests who scan this open a clean, read-only menu — they can't reach any staff screens.
          </p>

          <div className="qr-share__link">
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Public menu link" />
            <button type="button" className="btn small" onClick={copy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="qr-share__code">
            {qrDataUrl ? (
              <div className="qr-share__qr">
                <img src={qrDataUrl} width={240} height={240} alt={`QR code linking to the public menu for ${cafeName || slug}`} />
              </div>
            ) : (
              <div className="qr-share__qr qr-share__qr--empty">Generating…</div>
            )}
          </div>

          <div className="qr-share__actions">
            <a className="btn small" href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} /> Preview
            </a>
            <button type="button" className="btn small" onClick={downloadPng}>
              <Download size={14} /> PNG
            </button>
            <button type="button" className="btn small" onClick={downloadSvg} disabled={!qrDataUrl}>
              <Download size={14} /> SVG
            </button>
            <button type="button" className="btn small primary" onClick={() => setView('print')}>
              <Printer size={14} /> Print card
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
