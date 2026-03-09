const FR_BASE_URL = 'https://www.federalregister.gov/api/v1';

export class FederalRegisterClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(r => setTimeout(r, 100));
    const url = new URL(`${FR_BASE_URL}${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`FedReg ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getDocuments(params: Record<string, string> = {}): Promise<FRDocument[]> {
    const data = await this.fetch<{ results: FRDocument[] }>('/documents.json', {
      per_page: '100',
      order: 'newest',
      ...params,
    });
    return data.results;
  }

  async getExecutiveOrders(president?: string): Promise<FRDocument[]> {
    const params: Record<string, string> = {
      'conditions[type][]': 'PRESDOCU',
      'conditions[presidential_document_type][]': 'executive_order',
      per_page: '100',
    };
    if (president) params['conditions[president]'] = president;
    return this.getDocuments(params);
  }

  async getRecentRules(daysBack: number = 7): Promise<FRDocument[]> {
    const since = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
    return this.getDocuments({
      'conditions[type][]': 'RULE',
      'conditions[publication_date][gte]': since,
    });
  }
}

export interface FRDocument {
  document_number: string;
  title: string;
  type: string;
  abstract: string;
  publication_date: string;
  agencies: { raw_name: string; id: number }[];
  docket_ids: string[];
  cfr_references: { title: number; part: number }[];
  html_url: string;
  pdf_url: string;
  effective_on: string;
  presidential_document_type?: string;
  executive_order_number?: number;
  signing_date?: string;
  significant: boolean;
}
