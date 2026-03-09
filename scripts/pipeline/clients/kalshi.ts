const KALSHI_BASE_URL = 'https://trading-api.kalshi.com/trade-api/v2';

export class KalshiClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const url = new URL(`${KALSHI_BASE_URL}${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Kalshi ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getEvents(params: Record<string, string> = {}): Promise<KalshiEvent[]> {
    const data = await this.fetch<{ events: KalshiEvent[] }>('/events', params);
    return data.events;
  }

  async getMarkets(eventTicker: string): Promise<KalshiMarket[]> {
    const data = await this.fetch<{ markets: KalshiMarket[] }>(
      '/markets', { event_ticker: eventTicker }
    );
    return data.markets;
  }

  async getMarketHistory(ticker: string): Promise<KalshiSnapshot[]> {
    const data = await this.fetch<{ history: KalshiSnapshot[] }>(
      `/markets/${ticker}/history`, { limit: '1000' }
    );
    return data.history;
  }

  async getPoliticalEvents(): Promise<KalshiEvent[]> {
    return this.getEvents({ category: 'Politics' });
  }
}

export interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  sub_title: string;
  markets: { ticker: string; outcome: string; yes_price: number; volume: number }[];
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  outcome: string;
  yes_price: number;
  no_price: number;
  volume: number;
  open_time: string;
  close_time: string;
  status: string;
  result: string;
}

export interface KalshiSnapshot {
  ts: number;
  yes_price: number;
  volume: number;
}
