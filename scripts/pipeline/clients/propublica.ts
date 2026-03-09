const PP_CONGRESS_URL = 'https://api.propublica.org/congress/v1';
const PP_NONPROFIT_URL = 'https://projects.propublica.org/nonprofits/api/v2';

export class ProPublicaCongressClient {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async fetch<T>(endpoint: string): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const resp = await fetch(`${PP_CONGRESS_URL}${endpoint}`, {
      headers: { 'X-API-Key': this.apiKey },
    });
    if (!resp.ok) throw new Error(`ProPublica ${resp.status}: ${endpoint}`);
    const data = await resp.json() as { results: T[] };
    return data.results[0] as T;
  }

  async getMembers(congress: number, chamber: 'senate' | 'house') {
    return this.fetch<{ members: PPMember[] }>(`/${congress}/${chamber}/members.json`);
  }

  async getMemberVotes(memberId: string) {
    return this.fetch<{ votes: PPVote[] }>(`/members/${memberId}/votes.json`);
  }

  async getRecentBills(congress: number, chamber: string, type: string) {
    return this.fetch<{ bills: PPBill[] }>(`/${congress}/${chamber}/bills/${type}.json`);
  }
}

export class ProPublicaNonprofitClient {
  async search(query: string): Promise<PPNonprofit[]> {
    await new Promise(r => setTimeout(r, 100));
    const resp = await fetch(`${PP_NONPROFIT_URL}/search.json?q=${encodeURIComponent(query)}`);
    if (!resp.ok) throw new Error(`PP Nonprofit ${resp.status}`);
    const data = await resp.json() as { organizations: PPNonprofit[] };
    return data.organizations;
  }

  async getOrganization(ein: string): Promise<PPNonprofitDetail> {
    const resp = await fetch(`${PP_NONPROFIT_URL}/organizations/${ein}.json`);
    if (!resp.ok) throw new Error(`PP Nonprofit ${resp.status}: ${ein}`);
    return resp.json() as Promise<PPNonprofitDetail>;
  }
}

export interface PPMember {
  id: string;
  first_name: string;
  last_name: string;
  party: string;
  state: string;
  district: string;
  votes_with_party_pct: number;
  missed_votes_pct: number;
  total_votes: number;
}

export interface PPVote {
  bill: { bill_id: string; title: string };
  position: string;
  date: string;
  result: string;
}

export interface PPBill {
  bill_id: string;
  title: string;
  sponsor_id: string;
  cosponsors: number;
  latest_major_action: string;
  latest_major_action_date: string;
}

export interface PPNonprofit {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  income_amount: number;
  revenue_amount: number;
}

export interface PPNonprofitDetail extends PPNonprofit {
  filings_with_data: PPFiling[];
}

export interface PPFiling {
  tax_prd_yr: number;
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  pdf_url: string;
}
