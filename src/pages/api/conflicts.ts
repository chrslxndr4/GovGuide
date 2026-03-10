export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url, request }) => {
  const view = url.searchParams.get('view');
  const alertType = url.searchParams.get('type');
  const minSeverity = url.searchParams.get('min_severity');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  // ------------------------------------------------------------------
  // Timeline view — returns data from mv_conflict_timeline
  // ------------------------------------------------------------------
  if (view === 'timeline') {
    let timelineQuery = supabase
      .from('mv_conflict_timeline')
      .select('id, alert_type, severity, description, official_name, detected_at')
      .order('detected_at', { ascending: true })
      .limit(500);

    if (alertType) timelineQuery = timelineQuery.eq('alert_type', alertType);
    if (minSeverity) timelineQuery = timelineQuery.gte('severity', parseFloat(minSeverity));
    if (dateFrom) timelineQuery = timelineQuery.gte('detected_at', dateFrom);
    if (dateTo) timelineQuery = timelineQuery.lte('detected_at', dateTo);

    const { data: timelineData, error: timelineError } = await timelineQuery;

    if (timelineError) {
      return new Response(JSON.stringify({ error: timelineError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ points: timelineData ?? [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ------------------------------------------------------------------
  // Default feed view
  // ------------------------------------------------------------------
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
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
  if (dateFrom) query = query.gte('detected_at', dateFrom);
  if (dateTo) query = query.lte('detected_at', dateTo);

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
