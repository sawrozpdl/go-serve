import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, Printer, ExternalLink, Check } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { toast } from '@/lib/toast';

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
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

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

  // Open a clean, print-ready "table tent" in a new window. No app chrome —
  // just the name, a prompt, the QR, and the URL, sized for a small card.
  const printTent = async () => {
    const w = window.open('', '_blank', 'width=460,height=680');
    if (!w) {
      toast.error('Pop-up blocked', 'Allow pop-ups to print the QR card.');
      return;
    }
    let printQr = qrDataUrl;
    try {
      printQr = await QRCode.toDataURL(url, { ...QR_OPTS, width: 1024, margin: 2 });
    } catch {
      // fall back to the on-screen resolution
    }
    const title = cafeName || 'Our Menu';
    w.document.write(`<!doctype html><html><head><meta charset="utf-8" />
<title>${escapeHtml(title)} — Menu QR</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a1a}
  .tent{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
        text-align:center;padding:40px 32px;gap:18px}
  .eyebrow{letter-spacing:.28em;text-transform:uppercase;font-size:12px;color:#b4541f;font-weight:700}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:30px;margin:0;line-height:1.1}
  p{margin:0;color:#555;font-size:15px}
  .qr{width:260px;height:260px;padding:16px;border:1px solid #eee;border-radius:16px;
      box-shadow:0 10px 30px -14px rgba(0,0,0,.3)}
  .qr img{width:100%;height:100%;display:block}
  .url{font-size:12px;color:#888;word-break:break-all;max-width:300px}
  @media print{.qr{box-shadow:none}}
</style></head>
<body><div class="tent">
  <span class="eyebrow">Scan for our menu</span>
  <h1>${escapeHtml(title)}</h1>
  <p>Point your phone camera at the code</p>
  <div class="qr"><img src="${printQr}" alt="Menu QR code" /></div>
  <div class="url">${escapeHtml(url)}</div>
</div>
<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
</body></html>`);
    w.document.close();
  };

  return (
    <Modal open={open} onClose={onClose} title="Public menu" subtitle="Share or print a QR for your guests">
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
          <button type="button" className="btn small primary" onClick={printTent}>
            <Printer size={14} /> Print card
          </button>
        </div>
      </div>
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
