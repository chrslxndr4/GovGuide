export interface PipelineResult {
  source: string;
  records_fetched: number;
  records_inserted: number;
  records_updated: number;
  records_skipped: number;
  errors: string[];
  duration_ms: number;
}

export interface PipelineConfig {
  name: string;
  schedule: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  enabled: boolean;
}

export interface FECApiConfig {
  apiKey: string;
  baseUrl: string;
  rateLimit: number;
}

export interface CongressApiConfig {
  apiKey: string;
  baseUrl: string;
  rateLimit: number;
}
