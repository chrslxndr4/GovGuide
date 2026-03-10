-- Add columns for comprehensive transparency data expansion

-- Photo and selection method for judges
ALTER TABLE judges ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE judges ADD COLUMN IF NOT EXISTS selection_method TEXT;

-- LittleSis cross-reference IDs
ALTER TABLE entities ADD COLUMN IF NOT EXISTS littlesis_id TEXT;
ALTER TABLE officials ADD COLUMN IF NOT EXISTS littlesis_id TEXT;

-- GitHub tracking for community submissions
ALTER TABLE community_submissions ADD COLUMN IF NOT EXISTS github_issue_url TEXT;

-- Additional relationship types for LittleSis data
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'board_member';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'fellow_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'member_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'family_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'owns';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'educated_at';
