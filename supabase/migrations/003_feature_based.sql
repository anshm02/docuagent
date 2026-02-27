-- DocuAgent V3 Migration: Journey-based → Feature-based documentation

-- 1. Rename journeys column to features on jobs table
ALTER TABLE jobs RENAME COLUMN journeys TO features;

-- 2. Rename journey columns on screens table
ALTER TABLE screens RENAME COLUMN journey_id TO feature_id;
ALTER TABLE screens RENAME COLUMN journey_step TO feature_slug;

-- 3. Change feature_slug from INTEGER to TEXT (was journey_step)
ALTER TABLE screens ALTER COLUMN feature_slug TYPE TEXT USING feature_slug::TEXT;

-- 4. Update jobs status CHECK constraint: planning_journeys → selecting_features
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
  'queued', 'analyzing_code', 'analyzing_prd', 'discovering', 'selecting_features',
  'crawling', 'analyzing_screens', 'generating_docs', 'completed', 'failed'
));

-- 5. Migrate any existing jobs with old status value
UPDATE jobs SET status = 'selecting_features' WHERE status = 'planning_journeys';
