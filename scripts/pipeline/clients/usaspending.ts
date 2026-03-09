const USA_BASE_URL = 'https://api.usaspending.gov/api/v2';

export class USAspendingClient {
  async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const resp = await fetch(`${USA_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`USAspending ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getSpendingByDistrict(state: string, district: string, fiscalYear: number) {
    return this.post<USASpendingGeoResponse>('/search/spending_by_geography/', {
      scope: 'place_of_performance',
      geo_layer: 'district',
      geo_layer_filters: [`${state}-${district}`],
      filters: {
        time_period: [{ start_date: `${fiscalYear}-10-01`, end_date: `${fiscalYear + 1}-09-30` }],
      },
    });
  }

  async getTopContractors(state: string, fiscalYear: number, limit: number = 20) {
    return this.post<USASpendingCategoryResponse>('/search/spending_by_category/recipient/', {
      filters: {
        time_period: [{ start_date: `${fiscalYear}-10-01`, end_date: `${fiscalYear + 1}-09-30` }],
        place_of_performance_locations: [{ country: 'USA', state }],
      },
      limit,
      page: 1,
    });
  }

  async searchAwards(keyword: string, limit: number = 25) {
    return this.post<USASpendingAwardResponse>('/search/spending_by_award/', {
      filters: { keywords: [keyword] },
      fields: [
        'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
        'Award Type', 'Start Date', 'End Date', 'Description',
      ],
      limit,
      page: 1,
      sort: 'Award Amount',
      order: 'desc',
    });
  }
}

export interface USASpendingGeoResponse {
  results: { display_name: string; aggregated_amount: number; per_capita: number }[];
}

export interface USASpendingCategoryResponse {
  results: { name: string; amount: number; id: string }[];
  category: string;
}

export interface USASpendingAwardResponse {
  results: Record<string, unknown>[];
  page_metadata: { page: number; hasNext: boolean; total: number };
}
