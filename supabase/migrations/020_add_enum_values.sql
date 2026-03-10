-- Add missing enum values for entity_type and jurisdiction_level

ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'political_party';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'other';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'nonprofit';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'government';

ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'township';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'school_district';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'special_district';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'local';
