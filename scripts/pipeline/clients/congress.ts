const CONGRESS_BASE_URL = 'https://api.congress.gov/v3';

export class CongressClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${CONGRESS_BASE_URL}${endpoint}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 750));
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Congress API ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    resultsKey: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const all: T[] = [];
    let offset = 0;
    const limit = 250;
    let hasMore = true;

    while (hasMore && offset / limit < maxPages) {
      const data = await this.fetch<Record<string, unknown>>(endpoint, {
        ...params,
        offset: String(offset),
        limit: String(limit),
      });
      const results = (data[resultsKey] as T[]) || [];
      all.push(...results);
      hasMore = results.length === limit;
      offset += limit;
    }
    return all;
  }

  async getBills(congress: number, params: Record<string, string> = {}) {
    return this.fetchAllPages<CongressBill>(
      `/bill/${congress}`, 'bills', params
    );
  }

  async getBillDetail(congress: number, type: string, number: number) {
    return this.fetch<{ bill: CongressBillDetail }>(
      `/bill/${congress}/${type}/${number}`
    );
  }

  async getMembers(params: Record<string, string> = {}) {
    return this.fetchAllPages<CongressMember>('/member', 'members', params);
  }

  async getMemberDetail(bioguideId: string) {
    return this.fetch<{ member: CongressMemberDetail }>(`/member/${bioguideId}`);
  }
}

export interface CongressBill {
  congress: number;
  type: string;
  number: number;
  title: string;
  latestAction: { actionDate: string; text: string };
  url: string;
}

export interface CongressBillDetail {
  congress: number;
  type: string;
  number: number;
  title: string;
  introducedDate: string;
  sponsors: { bioguideId: string; fullName: string }[];
  policyArea: { name: string };
  subjects: { legislativeSubjects: { name: string }[] };
  actions: { count: number };
  cosponsors: { count: number };
  latestAction: { actionDate: string; text: string };
}

export interface CongressMember {
  bioguideId: string;
  name: string;
  partyName: string;
  state: string;
  district?: number;
  terms: { item: { chamber: string; startYear: number; endYear?: number }[] };
}

export interface CongressMemberDetail extends CongressMember {
  birthYear: string;
  depiction: { imageUrl: string };
  sponsoredLegislation: { count: number };
  cosponsoredLegislation: { count: number };
}
