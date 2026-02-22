-- DocuAgent Initial Schema

-- Profiles table
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  display_name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  github_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Jobs table
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  status TEXT DEFAULT 'queued' CHECK (status IN (
    'queued', 'analyzing_code', 'analyzing_prd', 'planning_journeys',
    'crawling', 'analyzing_screens', 'generating_doc', 'completed', 'failed'
  )),
  app_url TEXT NOT NULL,
  app_name TEXT,
  login_url TEXT,
  credentials JSONB,
  github_repo_url TEXT,
  prd_file_path TEXT,
  product_description TEXT,
  config JSONB DEFAULT '{}',
  journeys JSONB,
  progress JSONB DEFAULT '{}',
  quality_score INTEGER,
  flagged_for_review BOOLEAN DEFAULT false,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Screens table
CREATE TABLE screens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) NOT NULL,
  url TEXT NOT NULL,
  route_path TEXT,
  nav_path TEXT,
  screenshot_url TEXT,
  dom_html TEXT,
  code_context JSONB,
  prd_context JSONB,
  analysis JSONB,
  confidence INTEGER,
  screen_type TEXT DEFAULT 'page' CHECK (screen_type IN ('page', 'modal', 'tab', 'drawer')),
  journey_id TEXT,
  journey_step INTEGER,
  created_entity_id TEXT,
  status TEXT DEFAULT 'discovered' CHECK (status IN ('discovered', 'crawled', 'analyzed', 'failed')),
  order_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Progress messages table
CREATE TABLE progress_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) NOT NULL,
  type TEXT CHECK (type IN ('info', 'screenshot', 'question', 'error', 'complete')),
  message TEXT NOT NULL,
  screenshot_url TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own profile" ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "Users see own jobs" ON jobs FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users see own screens" ON screens FOR ALL USING (
  job_id IN (SELECT id FROM jobs WHERE user_id = auth.uid())
);
CREATE POLICY "Users see own messages" ON progress_messages FOR ALL USING (
  job_id IN (SELECT id FROM jobs WHERE user_id = auth.uid())
);

-- Service role bypass (for worker)
CREATE POLICY "Service role full access profiles" ON profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access jobs" ON jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access screens" ON screens FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access messages" ON progress_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
