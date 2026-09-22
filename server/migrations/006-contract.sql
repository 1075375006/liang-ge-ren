ALTER TABLE memberships ADD COLUMN IF NOT EXISTS contract_accepted_at timestamptz;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
