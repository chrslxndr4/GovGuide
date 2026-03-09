export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

const VALID_TYPES = ['all', 'donor_vote', 'stock_committee', 'trade_timing', 'judicial_financial', 'prediction_anomaly'];

export const GET: APIRoute = async ({ params, url }) => {
  const type = params.type || 'all';
  if (!VALID_TYPES.includes(type)) {
    return new Response('Invalid feed type', { status: 404 });
  }

  const minSeverity = url.searchParams.get('min_severity');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

  let query = supabase
    .from('conflict_alerts')
    .select('*')
    .eq('status', 'active')
    .order('detected_at', { ascending: false })
    .limit(limit);

  if (type !== 'all') query = query.eq('alert_type', type);
  if (minSeverity) query = query.gte('severity_score', parseFloat(minSeverity));

  const { data: alerts, error } = await query;

  if (error) {
    return new Response('Internal error', { status: 500 });
  }

  const items = (alerts || []).map(a => `
    <item>
      <title>${escapeXml(a.description || a.alert_type)}</title>
      <description>${escapeXml(JSON.stringify(a.evidence || {}))}</description>
      <pubDate>${new Date(a.detected_at).toUTCString()}</pubDate>
      <guid isPermaLink="false">${a.id}</guid>
      <category>${a.alert_type}</category>
    </item>`).join('');

  const feedTitle = type === 'all'
    ? 'GovGuide — All Conflict Alerts'
    : `GovGuide — ${type.replace(/_/g, ' ')} Alerts`;

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${feedTitle}</title>
    <description>Government transparency conflict and anomaly alerts</description>
    <link>/conflicts</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
