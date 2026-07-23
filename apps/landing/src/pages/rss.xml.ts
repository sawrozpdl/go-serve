import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { withBase, BRAND } from '../data/site';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://goserve.com.np');
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime()
  );

  const items = posts
    .map((p) => {
      const url = new URL(withBase(`/blog/${p.id}`), base).href;
      return `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${url}</link>
      <guid>${url}</guid>
      <pubDate>${p.data.publishDate.toUTCString()}</pubDate>
      <description>${esc(p.data.description)}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(BRAND.name)} — Blog</title>
    <link>${new URL(withBase('/blog'), base).href}</link>
    <description>Practical guides for running a better cafe in Nepal.</description>
    <language>en</language>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
