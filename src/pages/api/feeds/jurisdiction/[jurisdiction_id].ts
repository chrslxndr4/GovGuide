export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

interface ConflictAlert {
  id: string;
  alert_type: string;
  description: string | null;
  evidence: Record<string, unknown> | null;
  severity_score: number | null;
  status: string;
  detected_at: string;
  jurisdiction_id: string | null;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRss(jurisdictionId: string, alerts: ConflictAlert[]): string {
  const items = alerts
    .map(
      (a) => `
    <item>
      <title>${escapeXml(a.description ?? a.alert_type)}</title>
      <description>${escapeXml(JSON.stringify(a.evidence ?? {}))}</description>
      <pubDate>${new Date(a.detected_at).toUTCString()}</pubDate>
      <guid isPermaLink="false">${a.id}</guid>
      <category>${a.alert_type}</category>
    </item>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>GovGuide — Conflict Alerts for ${escapeXml(jurisdictionId)}</title>
    <description>Government transparency conflict and anomaly alerts filtered by jurisdiction</description>
    <link>/conflicts</link>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

// ---------------------------------------------------------------------------
// JSON Feed helpers
// ---------------------------------------------------------------------------

interface JsonFeedExtensions {
  govguide: {
    severity_score: number | null;
    alert_type: string;
    status: string;
    jurisdiction_id: string | null;
  };
}

interface JsonFeedItem {
  id: string;
  title: string;
  content_text: string;
  date_published: string;
  tags: string[];
  extensions: JsonFeedExtensions;
}

interface JsonFeed {
  version: 'https://jsonfeed.org/version/1.1';
  title: string;
  home_page_url: string;
  feed_url: string;
  description: string;
  items: JsonFeedItem[];
}

function alertToJsonFeedItem(alert: ConflictAlert): JsonFeedItem {
  const evidenceSummary =
    alert.evidence != null
      ? JSON.stringify(alert.evidence)
      : 'No evidence details available.';

  return {
    id: alert.id,
    title: alert.description ?? alert.alert_type,
    content_text: evidenceSummary,
    date_published: new Date(alert.detected_at).toISOString(),
    tags: [alert.alert_type],
    extensions: {
      govguide: {
        severity_score: alert.severity_score,
        alert_type: alert.alert_type,
        status: alert.status,
        jurisdiction_id: alert.jurisdiction_id,
      },
    },
  };
}

function buildJsonFeed(
  jurisdictionId: string,
  alerts: ConflictAlert[],
): JsonFeed {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: `GovGuide — Conflict Alerts for ${jurisdictionId}`,
    home_page_url: '/conflicts',
    feed_url: `/api/feeds/jurisdiction/${jurisdictionId}?format=json`,
    description:
      'Government transparency conflict and anomaly alerts filtered by jurisdiction',
    items: alerts.map(alertToJsonFeedItem),
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export const GET: APIRoute = async ({ params, url }) => {
  const jurisdictionId = params.jurisdiction_id;

  if (!jurisdictionId || jurisdictionId.trim() === '') {
    return new Response('Missing jurisdiction_id', { status: 400 });
  }

  const format = url.searchParams.get('format');
  const useJsonFeed = format === 'json';

  const minSeverity = url.searchParams.get('min_severity');
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') ?? '50', 10),
    200,
  );

  let query = supabase
    .from('conflict_alerts')
    .select('*')
    .eq('status', 'active')
    .eq('jurisdiction_id', jurisdictionId)
    .order('detected_at', { ascending: false })
    .limit(limit);

  if (minSeverity) query = query.gte('severity_score', parseFloat(minSeverity));

  const { data: alerts, error } = await query;

  if (error) {
    if (useJsonFeed) {
      return new Response(
        JSON.stringify({ error: 'Internal error fetching alerts.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('Internal error', { status: 500 });
  }

  const typedAlerts = (alerts as ConflictAlert[]) ?? [];

  if (useJsonFeed) {
    const feed = buildJsonFeed(jurisdictionId, typedAlerts);
    return new Response(JSON.stringify(feed, null, 2), {
      headers: {
        'Content-Type': 'application/feed+json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const rss = buildRss(jurisdictionId, typedAlerts);
  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
