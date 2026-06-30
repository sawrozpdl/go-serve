// Browser file download — create a transient anchor and click it.
//
// Works for both data: URLs and blob object URLs. When passing a blob object
// URL the caller owns its lifecycle (revoke after the click); this helper only
// triggers the download.
export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
