export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url, request }) => {
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const alertType = url.searchParams.get('type');
  const minSeverity = url.searchParams.get('min_severity');
  const officialId = url.searchParams.get('official_id');
  const status = url.searchParams.get('status') || 'active';

  let query = supabase
    .from('conflict_alerts')
    .select('*, official:official_id(full_name, slug)', { count: 'exact' })
    .eq('status', status)
    .order('severity_score', { ascending: false })
    .order('detected_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (alertType) query = query.eq('alert_type', alertType);
  if (minSeverity) query = query.gte('severity_score', parseFloat(minSeverity));
  if (officialId) query = query.eq('official_id', officialId);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // RSS feed support
  const accept = request.headers.get('Accept') || '';
  if (accept.includes('application/rss+xml')) {
    const rss = generateRSS(data || []);
    return new Response(rss, {
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  }

  return new Response(JSON.stringify({
    alerts: data,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

function generateRSS(alerts: any[]): string {
  const items = alerts.map(a => `
    <item>
      <title>${escapeXml(a.description || a.alert_type)}</title>
      <description>${escapeXml(JSON.stringify(a.evidence))}</description>
      <pubDate>${new Date(a.detected_at).toUTCString()}</pubDate>
      <guid>${a.id}</guid>
      <category>${a.alert_type}</category>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>GovGuide Conflict Alerts</title>
    <description>Government transparency conflict alerts</description>
    <link>/conflicts</link>
    ${items}
  </channel>
</rss>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
