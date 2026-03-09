import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { PipelineResult } from '../../src/lib/types/api-clients.js';

export abstract class BasePipeline {
  protected supabase: SupabaseClient;
  protected results: PipelineResult;
  protected startTime: number;

  constructor() {
    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase credentials');
    this.supabase = createClient(url, key);
    this.startTime = Date.now();
    this.results = {
      source: this.getName(),
      records_fetched: 0,
      records_inserted: 0,
      records_updated: 0,
      records_skipped: 0,
      errors: [],
      duration_ms: 0,
    };
  }

  abstract getName(): string;
  abstract run(): Promise<void>;

  async execute(): Promise<PipelineResult> {
    console.log(`[${this.getName()}] Starting pipeline...`);
    try {
      await this.run();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.results.errors.push(msg);
      console.error(`[${this.getName()}] Fatal error: ${msg}`);
    }
    this.results.duration_ms = Date.now() - this.startTime;
    console.log(`[${this.getName()}] Complete.`, {
      fetched: this.results.records_fetched,
      inserted: this.results.records_inserted,
      updated: this.results.records_updated,
      errors: this.results.errors.length,
      duration: `${this.results.duration_ms}ms`,
    });
    return this.results;
  }

  protected async upsertEntity(
    entity: { entity_type: string; name: string; external_ids?: Record<string, string> },
    matchField: string,
    matchValue: string
  ): Promise<string> {
    const { data: existing } = await this.supabase
      .from('entities')
      .select('id')
      .contains('external_ids', { [matchField]: matchValue })
      .single();

    if (existing) return existing.id;

    const { data: inserted, error } = await this.supabase
      .from('entities')
      .insert({
        entity_type: entity.entity_type,
        name: entity.name,
        external_ids: entity.external_ids || { [matchField]: matchValue },
      })
      .select('id')
      .single();

    if (error) throw new Error(`Entity insert failed: ${error.message}`);
    this.results.records_inserted++;
    return inserted!.id;
  }

  protected async rateLimitedFetch(url: string, delayMs: number = 100): Promise<Response> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response;
  }
}
