// Printable QR "table tent" designs.
//
// Each template is a pure function that returns a COMPLETE, self-contained HTML
// document — its own <style>, no external assets — built on a fixed 440×620px
// card canvas (portrait, ~A6 proportion). The same document is used two ways:
//
//   • as a scaled-down live thumbnail in the picker (an <iframe srcdoc>), and
//   • as the actual print job (handed to printHTML() in ./printing).
//
// Because both paths render the identical markup at the identical pixel canvas,
// the preview is literally what prints — only the QR image resolution differs.
//
// These print on white paper, so they are deliberately independent of the app's
// dark theme and use web-safe font stacks (the isolated document can't load the
// app's brand fonts). Two rules hold across every design:
//   1. The QR always sits on a solid white plate with quiet-zone padding, so it
//      stays scannable even on dark or saturated backgrounds.
//   2. All interpolated text is HTML-escaped.

export type QrCardInput = {
  /** Cafe display name, shown as the headline. */
  title: string;
  /** Public menu URL the QR encodes; also printed as readable text. */
  url: string;
  /** A QR code as a data: URL (caller controls resolution). */
  qrDataUrl: string;
};

export type QrCardTemplate = {
  id: string;
  name: string;
  render: (input: QrCardInput) => string;
};

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

// Wrap a theme's paint + body in the shared card document. `html` flex-centers
// the fixed-size `body`, so the card sits dead-centre on whatever paper the
// printer uses (and fills the thumbnail iframe exactly).
function shell(title: string, css: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(title)} — Menu QR</title>
<style>
@page{margin:0}
*{box-sizing:border-box}
html{height:100%;margin:0;display:flex;align-items:center;justify-content:center;background:#fff}
body{margin:0;width:440px;height:620px;position:relative;overflow:hidden}
img{display:block}
${css}
</style></head><body>${inner}</body></html>`;
}

// Shared centred layout — name over a QR plate over the URL. Themes only repaint
// the shared classes (.eyebrow/.name/.prompt/.qr/.url), which keeps the markup
// identical and the per-theme code down to a few colour/type lines.
function centered(
  i: QrCardInput,
  opts: { css: string; eyebrow: string; prompt: string; divider?: string },
): string {
  const base = `
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:44px 36px;gap:16px}
.eyebrow{margin:0;font-size:12px;letter-spacing:.26em;text-transform:uppercase;font-weight:700}
.name{margin:0;line-height:1.08;font-size:33px}
.prompt{margin:0;font-size:15px}
.qr{padding:16px;border-radius:18px;background:#fff}
.qr img{width:236px;height:236px}
.url{font-size:12px;word-break:break-all;max-width:300px}
.rule{flex:0 0 auto}
`;
  const inner = `<div class="wrap">
  <p class="eyebrow">${esc(opts.eyebrow)}</p>
  <h1 class="name">${esc(i.title)}</h1>
  ${opts.divider ?? ''}
  <p class="prompt">${esc(opts.prompt)}</p>
  <div class="qr"><img src="${i.qrDataUrl}" width="236" height="236" alt="Menu QR code" /></div>
  <p class="url">${esc(i.url)}</p>
</div>`;
  return shell(i.title, base + opts.css, inner);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const classic: QrCardTemplate = {
  id: 'classic',
  name: 'Classic Cream',
  render: (i) =>
    centered(i, {
      eyebrow: 'Scan for our menu',
      prompt: 'Point your phone camera at the code',
      divider: '<div class="rule"></div>',
      css: `
body{background:#f6efe1;color:#2c2418;font-family:Georgia,'Times New Roman',serif}
.name{font-size:34px}
.eyebrow{color:#b4541f}
.prompt{color:#857a66;font-family:'Helvetica Neue',Arial,sans-serif}
.rule{width:42px;height:2px;background:#d39a55;border-radius:2px}
.qr{border:1px solid #ece2cf;box-shadow:0 12px 30px -16px rgba(60,40,10,.5)}
.url{color:#9c917b;font-family:'Helvetica Neue',Arial,sans-serif}
@media print{.qr{box-shadow:none}}`,
    }),
};

const midnight: QrCardTemplate = {
  id: 'midnight',
  name: 'Midnight',
  render: (i) =>
    centered(i, {
      eyebrow: 'Scan for our menu',
      prompt: 'Point your phone camera at the code',
      css: `
body{background:radial-gradient(120% 120% at 50% 0%,#1d1f2b 0%,#101119 72%);color:#eef0f6;font-family:'Helvetica Neue',Arial,sans-serif}
.name{font-size:34px;font-weight:600;letter-spacing:.01em}
.eyebrow{color:#ffb347}
.prompt{color:#aab0c4}
.qr{box-shadow:0 18px 44px -18px rgba(0,0,0,.85)}
.url{color:#727892;font-family:ui-monospace,'SFMono-Regular',Menlo,monospace}
@media print{.qr{box-shadow:none}}`,
    }),
};

const kraft: QrCardTemplate = {
  id: 'kraft',
  name: 'Kraft Paper',
  render: (i) =>
    centered(i, {
      eyebrow: 'Fresh off the press',
      prompt: 'Scan the code to browse our menu',
      divider: '<div class="rule"></div>',
      css: `
body{background:linear-gradient(135deg,rgba(255,255,255,.07),transparent 42%),linear-gradient(160deg,#cbad81,#bf9f70);color:#41331f;font-family:Georgia,'Times New Roman',serif}
.name{font-size:32px}
.eyebrow{color:#6b5331}
.prompt{color:#6e5c3e;font-family:'Helvetica Neue',Arial,sans-serif}
.rule{width:130px;height:0;border-top:2px dashed #8a6f48}
.qr{background:#fffdf6;box-shadow:0 10px 22px -14px rgba(40,28,10,.6)}
.url{color:#7a6647;font-family:'Helvetica Neue',Arial,sans-serif}
@media print{.qr{box-shadow:none}}`,
    }),
};

const minimal: QrCardTemplate = {
  id: 'minimal',
  name: 'Minimal Mono',
  render: (i) =>
    centered(i, {
      eyebrow: 'Menu',
      prompt: 'Scan to view',
      css: `
body{background:#fff;color:#141414;font-family:'Helvetica Neue',Arial,sans-serif}
body::before{content:"";position:absolute;inset:24px;border:1px solid #e6e6e6;border-radius:6px;pointer-events:none}
.wrap{gap:22px;padding:60px 44px}
.name{font-size:27px;font-weight:500;letter-spacing:.02em}
.eyebrow{color:#9a9a9a;letter-spacing:.34em;font-weight:600;font-size:11px}
.prompt{color:#9a9a9a;font-size:13px;letter-spacing:.03em}
.qr{padding:0;border-radius:0}
.qr img{width:230px;height:230px}
.url{color:#bdbdbd;font-size:11px;letter-spacing:.04em}`,
    }),
};

const ticket: QrCardTemplate = {
  id: 'ticket',
  name: 'Ticket Stub',
  render: (i) =>
    shell(
      i.title,
      `
body{background:#fbe9d7;color:#3a2a1c;font-family:ui-monospace,'SFMono-Regular',Menlo,'Courier New',monospace}
.stub{height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;border-bottom:2px dashed #c98b5e}
.stub .k{font-size:13px;letter-spacing:.42em;color:#cf4b1f;font-weight:700}
.stub .no{font-size:11px;letter-spacing:.22em;color:#a07a55}
.notch{position:absolute;top:150px;width:30px;height:30px;border-radius:50%;background:#fff;transform:translateY(-50%)}
.notch.l{left:-15px}
.notch.r{right:-15px}
.main{height:470px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:26px 34px}
.name{margin:0;font-family:Georgia,'Times New Roman',serif;font-size:29px;color:#3a2a1c}
.prompt{margin:0;font-size:12px;color:#7a5c3f;letter-spacing:.02em}
.qr{background:#fff;padding:14px;border-radius:12px;box-shadow:0 8px 20px -12px rgba(80,40,10,.5)}
.qr img{width:220px;height:220px}
.url{margin:0;font-size:11px;color:#a07a55;word-break:break-all;max-width:300px}
@media print{.qr{box-shadow:none}}`,
      `<div class="stub">
  <div class="k">SCAN · TO · VIEW</div>
  <div class="no">NO. 0042 · TODAY'S MENU</div>
</div>
<div class="notch l"></div><div class="notch r"></div>
<div class="main">
  <h1 class="name">${esc(i.title)}</h1>
  <p class="prompt">ADMIT ONE — POINT YOUR CAMERA HERE</p>
  <div class="qr"><img src="${i.qrDataUrl}" width="220" height="220" alt="Menu QR code" /></div>
  <p class="url">${esc(i.url)}</p>
</div>`,
    ),
};

const boldBlock: QrCardTemplate = {
  id: 'bold',
  name: 'Bold Block',
  render: (i) =>
    shell(
      i.title,
      `
body{background:#fff;color:#15110a;font-family:'Helvetica Neue',Arial,sans-serif}
.top{height:248px;background:linear-gradient(135deg,#ffb02e,#ff8f1f);padding:42px 38px;display:flex;flex-direction:column;justify-content:center;gap:12px}
.top .eyebrow{margin:0;color:rgba(20,12,0,.55);font-size:12px;letter-spacing:.26em;text-transform:uppercase;font-weight:700}
.top .name{margin:0;font-size:42px;line-height:1.02;font-weight:800;color:#1a1206;letter-spacing:-.01em}
.bottom{height:372px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}
.prompt{margin:0;color:#6b6256;font-size:14px}
.qr{padding:14px;border-radius:14px;background:#fff;box-shadow:0 14px 30px -16px rgba(0,0,0,.35)}
.qr img{width:226px;height:226px}
.url{margin:0;font-size:12px;color:#a59c8e;word-break:break-all;max-width:300px}
@media print{.qr{box-shadow:none}}`,
      `<div class="top">
  <p class="eyebrow">Our Menu</p>
  <h1 class="name">${esc(i.title)}</h1>
</div>
<div class="bottom">
  <p class="prompt">Scan the code to see what's on</p>
  <div class="qr"><img src="${i.qrDataUrl}" width="226" height="226" alt="Menu QR code" /></div>
  <p class="url">${esc(i.url)}</p>
</div>`,
    ),
};

const sage: QrCardTemplate = {
  id: 'sage',
  name: 'Sage Botanical',
  render: (i) =>
    centered(i, {
      eyebrow: 'Please scan',
      prompt: 'Open the menu on your phone',
      divider: '<div class="rule">&#10087;</div>',
      css: `
body{background:linear-gradient(180deg,#eaf0e4,#dde7d6);color:#2f3a2a;font-family:Georgia,'Times New Roman',serif}
.name{font-size:33px}
.eyebrow{color:#5d7150}
.prompt{color:#5f6d54;font-family:'Helvetica Neue',Arial,sans-serif}
.rule{color:#7d9b6a;font-size:22px;line-height:1}
.qr{border:1px solid #d2ddc8;box-shadow:0 12px 28px -16px rgba(40,60,30,.45)}
.url{color:#7c8a6f;font-family:'Helvetica Neue',Arial,sans-serif}
@media print{.qr{box-shadow:none}}`,
    }),
};

const receipt: QrCardTemplate = {
  id: 'receipt',
  name: 'Receipt',
  render: (i) =>
    shell(
      i.title,
      `
body{background:#fff;color:#111;font-family:'Courier New',ui-monospace,monospace}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;padding:42px 40px}
.star{margin:0;font-size:13px;letter-spacing:.18em;font-weight:700}
.dash{width:100%;border:0;border-top:2px dashed #111;margin:6px 0}
.name{margin:0;font-size:25px;font-weight:700;letter-spacing:.02em}
.prompt{margin:0;font-size:12px;letter-spacing:.02em}
.qr{padding:12px;border:1.5px solid #111;border-radius:6px;background:#fff}
.qr img{width:222px;height:222px}
.url{margin:0;font-size:11px;word-break:break-all;max-width:300px}
.foot{margin:0;font-size:12px;letter-spacing:.14em;font-weight:700}`,
      `<div class="wrap">
  <p class="star">&#9733; SCAN TO ORDER &#9733;</p>
  <hr class="dash" />
  <h1 class="name">${esc(i.title)}</h1>
  <p class="prompt">POINT CAMERA AT CODE BELOW</p>
  <hr class="dash" />
  <div class="qr"><img src="${i.qrDataUrl}" width="222" height="222" alt="Menu QR code" /></div>
  <hr class="dash" />
  <p class="url">${esc(i.url)}</p>
  <p class="foot">THANK YOU</p>
</div>`,
    ),
};

const framed: QrCardTemplate = {
  id: 'framed',
  name: 'Framed Deco',
  render: (i) =>
    centered(i, {
      eyebrow: 'The Menu',
      prompt: 'Scan to browse our offerings',
      divider: '<div class="rule">&#9670; &#9670; &#9670;</div>',
      css: `
body{background:#f5efe2;color:#34291a;font-family:Georgia,'Times New Roman',serif}
body::before{content:"";position:absolute;inset:20px;border:2px solid #b8862f;pointer-events:none}
body::after{content:"";position:absolute;inset:28px;border:1px solid #cdab63;pointer-events:none}
.name{font-size:32px}
.eyebrow{color:#9a7320;letter-spacing:.3em}
.prompt{color:#8a7a5e;font-family:'Helvetica Neue',Arial,sans-serif}
.rule{color:#b8862f;font-size:11px;letter-spacing:.2em}
.qr{border:1px solid #d8bd84;box-shadow:0 10px 24px -16px rgba(80,60,20,.5)}
.url{color:#9c8a68;font-family:'Helvetica Neue',Arial,sans-serif}
@media print{.qr{box-shadow:none}}`,
    }),
};

const coral: QrCardTemplate = {
  id: 'coral',
  name: 'Coral Pop',
  render: (i) =>
    centered(i, {
      eyebrow: 'Hey there!',
      prompt: 'Scan to see the good stuff',
      css: `
body{background:linear-gradient(155deg,#ff7e5f 0%,#ffb56b 100%);color:#fff;font-family:'Helvetica Neue',Arial,sans-serif}
.name{font-size:34px;font-weight:800;text-shadow:0 2px 12px rgba(150,40,10,.25)}
.eyebrow{color:rgba(255,255,255,.85)}
.prompt{color:rgba(255,255,255,.92)}
.qr{border-radius:22px;padding:18px;box-shadow:0 18px 40px -18px rgba(120,30,0,.5)}
.qr img{width:230px;height:230px}
.url{color:rgba(255,255,255,.9)}
@media print{.qr{box-shadow:none}}`,
    }),
};

const noir: QrCardTemplate = {
  id: 'noir',
  name: 'Noir Contrast',
  render: (i) =>
    centered(i, {
      eyebrow: 'Scan',
      prompt: 'Our menu, on your phone',
      css: `
body{background:#000;color:#fff;font-family:'Helvetica Neue',Arial,sans-serif}
.wrap{gap:20px}
.name{font-size:40px;font-weight:800;text-transform:uppercase;letter-spacing:-.01em;line-height:.98}
.eyebrow{color:#fff;letter-spacing:.42em;font-size:11px}
.prompt{color:#bdbdbd;font-size:13px;letter-spacing:.04em}
.qr{padding:16px;border-radius:4px}
.qr img{width:234px;height:234px}
.url{color:#8a8a8a;font-family:ui-monospace,'SFMono-Regular',Menlo,monospace;font-size:11px}`,
    }),
};

const espresso: QrCardTemplate = {
  id: 'espresso',
  name: 'Espresso',
  render: (i) =>
    centered(i, {
      eyebrow: 'Scan for our menu',
      prompt: 'Point your camera at the code',
      divider: '<div class="rule"></div>',
      css: `
body{background:radial-gradient(120% 130% at 50% 0%,#43291a 0%,#2a1810 76%);color:#f1e3cd;font-family:Georgia,'Times New Roman',serif}
.name{font-size:33px}
.eyebrow{color:#cba253}
.prompt{color:#c2ad8f;font-family:'Helvetica Neue',Arial,sans-serif}
.rule{width:46px;height:2px;background:#c9a24a;border-radius:2px}
.qr{box-shadow:0 16px 36px -18px rgba(0,0,0,.7)}
.url{color:#9a8462;font-family:'Helvetica Neue',Arial,sans-serif}
@media print{.qr{box-shadow:none}}`,
    }),
};

/** All designs, in display order. The first is the default selection. */
export const QR_CARD_TEMPLATES: QrCardTemplate[] = [
  classic,
  midnight,
  kraft,
  minimal,
  ticket,
  boldBlock,
  sage,
  receipt,
  framed,
  coral,
  noir,
  espresso,
];

export const DEFAULT_QR_CARD_ID = classic.id;

/** Look up a template by id, falling back to the default if it's unknown. */
export function qrCardTemplate(id: string | null | undefined): QrCardTemplate {
  return QR_CARD_TEMPLATES.find((t) => t.id === id) ?? classic;
}
