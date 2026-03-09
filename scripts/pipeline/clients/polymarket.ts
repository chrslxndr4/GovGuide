const POLYMARKET_BASE_URL = 'https://clob.polymarket.com';
const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

export class PolymarketClient {
  async getMarkets(params: { next_cursor?: string; limit?: number } = {}): Promise<PolymarketMarketsResponse> {
    const url = new URL(`${GAMMA_BASE_URL}/markets`);
    if (params.next_cursor) url.searchParams.set('next_cursor', params.next_cursor);
    url.searchParams.set('limit', String(params.limit || 100));
    url.searchParams.set('active', 'true');
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    return resp.json() as Promise<PolymarketMarketsResponse>;
  }

  async getMarketBySlug(slug: string): Promise<PolymarketMarket> {
    const resp = await fetch(`${GAMMA_BASE_URL}/markets?slug=${slug}`);
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    const data = await resp.json() as PolymarketMarket[];
    if (!data.length) throw new Error(`Market not found: ${slug}`);
    return data[0];
  }

  async getElectionMarkets(): Promise<PolymarketMarket[]> {
    const all: PolymarketMarket[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const resp = await this.getMarkets({ next_cursor: cursor });
      const political = resp.data?.filter((m: PolymarketMarket) =>
        m.category === 'Politics' || m.tags?.includes('elections')
      ) || [];
      all.push(...political);
      if (!resp.next_cursor) break;
      cursor = resp.next_cursor;
      await new Promise(r => setTimeout(r, 200));
    }
    return all;
  }
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  category: string;
  tags?: string[];
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  resolutionSource: string;
}

interface PolymarketMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}
