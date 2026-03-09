export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';

const VALID_TYPES = [
  'all',
  'donor_vote',
  'stock_committee',
  'trade_timing',
  'judicial_financial',
  'prediction_anomaly',
] as const;

type FeedType = (typeof VALID_TYPES)[number];

interface ConflictAlert {
  id: string;
  alert_type: FeedType;
  description: string | null;
  evidence: Record<string, unknown> | null;
  severity_score: number | null;
  status: string;
  detected_at: string;
  jurisdiction_id: string | null;
}

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

function buildFeedTitle(type: string): string {
  if (type === 'all') return 'GovGuide — All Conflict Alerts';
  return `GovGuide — ${type.replace(/_/g, ' ')} Alerts`;
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

export const GET: APIRoute = async ({ params, url }) => {
  const type = params.type ?? 'all';

  if (!VALID_TYPES.includes(type as FeedType)) {
    return new Response('Invalid feed type', { status: 404 });
  }

  const minSeverity = url.searchParams.get('min_severity');
  const limit = Math.min(
    parseInt(url.searchParams.get('limit') ?? '50', 10),
    200,
  );

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
    return new Response(
      JSON.stringify({ error: 'Internal error fetching alerts.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const feedUrl = `/api/feeds/json/${type}`;
  const title = buildFeedTitle(type);

  const feed: JsonFeed = {
    version: 'https://jsonfeed.org/version/1.1',
    title,
    home_page_url: '/conflicts',
    feed_url: feedUrl,
    description: 'Government transparency conflict and anomaly alerts',
    items: (alerts as ConflictAlert[] ?? []).map(alertToJsonFeedItem),
  };

  return new Response(JSON.stringify(feed, null, 2), {
    headers: {
      'Content-Type': 'application/feed+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
