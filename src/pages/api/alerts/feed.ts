import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const format = url.searchParams.get('format') ?? 'json';
  const alertType = url.searchParams.get('alert_type');
  const severityMin = url.searchParams.get('severity_min');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  let query = supabase
    .from('conflict_alerts')
    .select('*')
    .eq('status', 'active')
    .order('detected_at', { ascending: false })
    .limit(limit);

  if (alertType) query = query.eq('alert_type', alertType);
  if (severityMin) query = query.gte('severity_score', parseFloat(severityMin));

  const { data: alerts, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: 'Failed to fetch alerts' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (format === 'rss') {
    const items = (alerts ?? [])
      .map(
        (a) => `    <item>
      <title>${escapeXml(a.description?.substring(0, 100) ?? 'Conflict Alert')}</title>
      <description>${escapeXml(a.description ?? '')}</description>
      <pubDate>${new Date(a.detected_at).toUTCString()}</pubDate>
      <guid>${a.id}</guid>
      <category>${a.alert_type}</category>
    </item>`
      )
      .join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>GovGuide Conflict Alerts</title>
    <description>Automated conflict of interest detection</description>
    <link>/conflicts</link>
${items}
  </channel>
</rss>`;

    return new Response(rss, {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  }

  return new Response(JSON.stringify({ data: alerts ?? [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
