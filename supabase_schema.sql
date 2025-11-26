-- Supabase Schema for Surveyly+

-- Enable UUID generation extension (Supabase supports this)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Survey Questions Table
CREATE TABLE survey_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE, -- stable identifier used by frontend (e.g., 'age')
  text TEXT NOT NULL,
  type TEXT NOT NULL,
  options JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  in_bank BOOLEAN DEFAULT FALSE
);

-- Survey Responses Table
CREATE TABLE survey_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID REFERENCES survey_questions(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Question Bank Table
CREATE TABLE question_bank (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_text TEXT NOT NULL,
  type TEXT NOT NULL,
  options JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Suggestions Table
CREATE TABLE suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  text TEXT NOT NULL,
  status TEXT DEFAULT 'none' CHECK (status IN ('none', 'red', 'green')),
  question_id UUID REFERENCES survey_questions(id) ON DELETE SET NULL,
  question_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Form Stats Table
CREATE TABLE form_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  forms_filled INTEGER DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Version History Table
CREATE TABLE version_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  change_summary TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row Level Security Policies

-- Allow anyone to read survey questions
ALTER TABLE survey_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_survey_questions_all" ON survey_questions
  FOR SELECT USING (true);
CREATE POLICY "insert_survey_questions_all" ON survey_questions
  FOR INSERT WITH CHECK (true);
-- Example admin-only delete policy: restrict deletes to service role or admin email
-- Note: Supabase exposes JWT claims in request context; adjust to your setup.
CREATE POLICY "delete_survey_questions_admin" ON survey_questions
  FOR DELETE USING (
    current_setting('request.jwt.claim.role', true) = 'service_role'
    OR (nullif(current_setting('request.jwt.claim.email', true), '') = current_setting('app.admin_email', true))
  );

-- Allow anyone to read survey responses
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_survey_responses_all" ON survey_responses
  FOR SELECT USING (true);
CREATE POLICY "insert_survey_responses_all" ON survey_responses
  FOR INSERT WITH CHECK (true);
CREATE POLICY "delete_survey_responses_admin" ON survey_responses
  FOR DELETE USING (
    current_setting('request.jwt.claim.role', true) = 'service_role'
    OR (nullif(current_setting('request.jwt.claim.email', true), '') = current_setting('app.admin_email', true))
  );

-- Similar policies for other tables
ALTER TABLE question_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE version_history ENABLE ROW LEVEL SECURITY;

-- For brevity, apply similar policies to other tables
CREATE POLICY "read_question_bank_all" ON question_bank FOR SELECT USING (true);
CREATE POLICY "insert_question_bank_all" ON question_bank FOR INSERT WITH CHECK (true);
CREATE POLICY "delete_question_bank_admin" ON question_bank FOR DELETE USING (
  current_setting('request.jwt.claim.role', true) = 'service_role'
  OR (nullif(current_setting('request.jwt.claim.email', true), '') = current_setting('app.admin_email', true))
);

CREATE POLICY "read_suggestions_all" ON suggestions FOR SELECT USING (true);
CREATE POLICY "insert_suggestions_all" ON suggestions FOR INSERT WITH CHECK (true);
CREATE POLICY "update_suggestions_all" ON suggestions FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "delete_suggestions_admin" ON suggestions FOR DELETE USING (
  current_setting('request.jwt.claim.role', true) = 'service_role'
  OR (nullif(current_setting('request.jwt.claim.email', true), '') = current_setting('app.admin_email', true))
);

CREATE POLICY "read_form_stats_all" ON form_stats FOR SELECT USING (true);
CREATE POLICY "insert_form_stats_all" ON form_stats FOR INSERT WITH CHECK (true);
CREATE POLICY "update_form_stats_all" ON form_stats FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "delete_form_stats_admin" ON form_stats FOR DELETE USING (
  current_setting('request.jwt.claim.role', true) = 'service_role'
  OR (nullif(current_setting('request.jwt.claim.email', true), '') = current_setting('app.admin_email', true))
);



-- Optional: set admin email used in policies (adjust value)
-- ALTER DATABASE SET app.admin_email = 'admin@example.com';