-- DocuAgent V2 Migration: Discovery crawl, cost budget, analysis visibility

-- 1. Add credits column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 300;

-- 2. Add new columns to jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_cost_cents INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS discovery_data JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS code_analysis_summary TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prd_analysis_summary TEXT;

-- 3. Update jobs status CHECK constraint to include 'discovering' and rename 'generating_doc' → 'generating_docs'
-- Drop old constraint and add new one
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
  'queued', 'analyzing_code', 'analyzing_prd', 'discovering', 'planning_journeys',
  'crawling', 'analyzing_screens', 'generating_docs', 'completed', 'failed'
));

-- 4. Migrate any existing jobs with old status value
UPDATE jobs SET status = 'generating_docs' WHERE status = 'generating_doc';
