import { describe, it, expect } from 'vitest';
import { FECClient } from '../clients/fec.js';

describe('FECClient', () => {
  it('constructs valid candidate search URL', () => {
    const client = new FECClient('TEST_KEY');
    const url = client.buildUrl('/candidates/', { state: 'CA', office: 'S' });
    expect(url).toContain('api.open.fec.gov/v1/candidates/');
    expect(url).toContain('api_key=TEST_KEY');
    expect(url).toContain('state=CA');
    expect(url).toContain('office=S');
  });

  it('constructs valid schedule_a URL with pagination', () => {
    const client = new FECClient('TEST_KEY');
    const url = client.buildUrl('/schedules/schedule_a/', {
      committee_id: 'C00001234',
      per_page: '100',
    });
    expect(url).toContain('committee_id=C00001234');
    expect(url).toContain('per_page=100');
  });
});
