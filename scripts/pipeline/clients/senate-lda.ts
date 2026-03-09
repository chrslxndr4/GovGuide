const LDA_BASE_URL = 'https://lda.senate.gov/api/v1';

export class SenateLDAClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 200));
    const url = new URL(`${LDA_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`LDA API ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const all: T[] = [];
    let nextUrl: string | null = null;
    let page = 0;

    const firstPage = await this.fetch<LDAPaginatedResponse<T>>(endpoint, {
      ...params,
      page_size: '25',
    });
    all.push(...firstPage.results);
    nextUrl = firstPage.next;
    page++;

    while (nextUrl && page < maxPages) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(nextUrl);
      if (!response.ok) break;
      const data = (await response.json()) as LDAPaginatedResponse<T>;
      all.push(...data.results);
      nextUrl = data.next;
      page++;
    }
    return all;
  }

  async getFilings(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAFiling>('/filings/', params);
  }

  async getRegistrants(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDARegistrant>('/registrants/', params);
  }

  async getClients(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAClient>('/clients/', params);
  }

  async getContributions(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAContribution>('/contributions/', params);
  }
}

interface LDAPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface LDAFiling {
  filing_uuid: string;
  filing_type: string;
  filing_year: number;
  filing_period: string;
  registrant: { id: number; name: string };
  client: { id: number; name: string };
  income: string | null;
  expenses: string | null;
  lobbying_activities: LDALobbyingActivity[];
  posted_by_name: string;
  dt_posted: string;
}

export interface LDALobbyingActivity {
  general_issue_code: string;
  general_issue_code_display: string;
  description: string;
  lobbyists: { lobbyist: { id: number; name: string }; covered_position: string }[];
  government_entities: { id: number; name: string }[];
}

export interface LDARegistrant {
  id: number;
  name: string;
  description: string;
  address: string;
  country: string;
}

export interface LDAClient {
  id: number;
  name: string;
  general_description: string;
  country: string;
  state: string;
}

export interface LDAContribution {
  filing_uuid: string;
  lobbyist_name: string;
  contributor_name: string;
  payee_name: string;
  amount: string;
  contribution_date: string;
  contribution_type: string;
}
