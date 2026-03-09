const FEC_BASE_URL = 'https://api.open.fec.gov/v1';

export class FECClient {
  private apiKey: string;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${FEC_BASE_URL}${endpoint}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount >= 950) {
      const elapsed = Date.now() - this.windowStart;
      if (elapsed < 3600000) {
        const wait = 3600000 - elapsed + 1000;
        console.log(`[FEC] Rate limit approaching, waiting ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await this.throttle();
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`FEC API error ${response.status}: ${endpoint}`);
    }
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const allResults: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= maxPages) {
      const data = await this.fetch<{
        results: T[];
        pagination: { pages: number; page: number; count: number };
      }>(endpoint, { ...params, page: String(page), per_page: '100' });

      allResults.push(...data.results);
      hasMore = page < data.pagination.pages;
      page++;
    }

    return allResults;
  }

  async getCandidates(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECCandidate>('/candidates/', params);
  }

  async getCommittees(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECCommittee>('/committees/', params);
  }

  async getContributions(committeeId: string, params: Record<string, string> = {}) {
    return this.fetchAllPages<FECContribution>(
      '/schedules/schedule_a/',
      { committee_id: committeeId, ...params }
    );
  }

  async getIndependentExpenditures(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECIndependentExpenditure>(
      '/schedules/schedule_e/',
      params
    );
  }
}

export interface FECCandidate {
  candidate_id: string;
  name: string;
  party: string;
  state: string;
  district: string;
  office: string;
  incumbent_challenge: string;
  candidate_status: string;
  principal_committees: { committee_id: string; name: string }[];
}

export interface FECCommittee {
  committee_id: string;
  name: string;
  committee_type: string;
  designation: string;
  party: string;
  state: string;
  treasurer_name: string;
  sponsor_candidate_ids: string[];
}

export interface FECContribution {
  committee_id: string;
  contributor_name: string;
  contributor_employer: string;
  contributor_occupation: string;
  contributor_city: string;
  contributor_state: string;
  contributor_zip: string;
  contribution_receipt_amount: number;
  contribution_receipt_date: string;
  fec_election_type_desc: string;
  memo_text: string;
  sub_id: string;
}

export interface FECIndependentExpenditure {
  committee_id: string;
  committee_name: string;
  candidate_id: string;
  candidate_name: string;
  support_oppose_indicator: string;
  expenditure_amount: number;
  expenditure_date: string;
  purpose: string;
  payee_name: string;
}
