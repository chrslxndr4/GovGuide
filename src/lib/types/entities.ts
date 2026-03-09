export type EntityType =
  | 'person' | 'corporation' | 'pac' | 'super_pac' | 'hybrid_pac'
  | '501c4' | '501c3' | '527_org' | 'lobbying_firm' | 'trade_association'
  | 'foreign_principal' | 'labor_union' | 'political_party';

export type RelationshipType =
  | 'donated_to' | 'contributed_to' | 'spent_for' | 'spent_against'
  | 'granted_to' | 'lobbied_via' | 'paid_by'
  | 'represents' | 'sits_on' | 'appointed_by' | 'confirmed_by'
  | 'employed_by' | 'previously_held' | 'registered_for'
  | 'sponsored' | 'cosponsored' | 'voted_yea' | 'voted_nay'
  | 'voted_present' | 'voted_absent' | 'lobbied_on' | 'commented_on'
  | 'affects_industry'
  | 'decided' | 'party_to' | 'holds_stock' | 'oversees'
  | 'traded_stock' | 'board_member' | 'affiliated_with';

export interface Entity {
  id?: string;
  entity_type: EntityType;
  name: string;
  aliases?: string[];
  external_ids?: Record<string, string>;
  description?: string;
  website?: string;
  metadata?: Record<string, unknown>;
}

export interface Relationship {
  id?: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: RelationshipType;
  amount?: number;
  date_start?: string;
  date_end?: string;
  cycle?: string;
  metadata?: Record<string, unknown>;
  confidence_score?: number;
  source?: string;
}
