-- Additive upgrade: existing accounts, points and spaces are preserved.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_created_idx ON password_reset_tokens(user_id, created_at DESC);
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS password_reset_token_id uuid REFERENCES password_reset_tokens(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS tasks_space_status_page_idx ON tasks(space_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS products_space_page_idx ON products(space_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS schedules_space_page_idx ON schedules(space_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_space_page_idx ON orders(space_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ledger_user_space_page_idx ON point_ledger(user_id, space_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_page_idx ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
