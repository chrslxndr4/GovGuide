const CL_BASE_URL = 'https://www.courtlistener.com/api/rest/v4';

export class CourtListenerClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 200));
    const url = new URL(`${CL_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Token ${this.token}` },
    });
    if (!response.ok) throw new Error(`CourtListener ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 50
  ): Promise<T[]> {
    const all: T[] = [];
    let nextUrl: string | null = null;
    let page = 0;

    const first = await this.fetch<CLPaginatedResponse<T>>(endpoint, params);
    all.push(...first.results);
    nextUrl = first.next;
    page++;

    while (nextUrl && page < maxPages) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const resp = await fetch(nextUrl, {
        headers: { Authorization: `Token ${this.token}` },
      });
      if (!resp.ok) break;
      const data = (await resp.json()) as CLPaginatedResponse<T>;
      all.push(...data.results);
      nextUrl = data.next;
      page++;
    }
    return all;
  }

  async getJudges(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLJudge>('/people/', params);
  }

  async getFinancialDisclosures(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLFinancialDisclosure>('/financial-disclosures/', params);
  }

  async getInvestments(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLInvestment>('/investments/', params);
  }

  async getOpinions(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLOpinion>('/opinions/', params);
  }

  async getCourts(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLCourt>('/courts/', params);
  }
}

interface CLPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface CLJudge {
  id: number;
  resource_uri: string;
  name_first: string;
  name_last: string;
  name_middle: string;
  date_dob: string;
  gender: string;
  race: string[];
  positions: CLPosition[];
  educations: CLEducation[];
  aba_ratings: CLABARating[];
}

export interface CLPosition {
  court: string;
  date_start: string;
  date_termination: string | null;
  appointer: string | null;
  how_selected: string;
  nomination_process: string;
  date_confirmation: string;
  votes_yes: number;
  votes_no: number;
}

export interface CLEducation {
  school: { name: string };
  degree_level: string;
  degree_year: number;
}

export interface CLABARating {
  rating: string;
  year_rated: number;
}

export interface CLFinancialDisclosure {
  id: number;
  person: string;
  year: number;
  investments: string[];
  has_been_extracted: boolean;
}

export interface CLInvestment {
  id: number;
  financial_disclosure: string;
  description: string;
  page_number: number;
  gross_value_code: string;
  income_during_reporting_period_code: string;
}

export interface CLOpinion {
  id: number;
  resource_uri: string;
  cluster: string;
  author: string;
  type: string;
  date_created: string;
  plain_text: string;
  html: string;
}

export interface CLCourt {
  id: string;
  full_name: string;
  short_name: string;
  jurisdiction: string;
  date_modified: string;
}
