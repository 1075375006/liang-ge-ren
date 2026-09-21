-- Retention bookkeeping is separate from business records and worker health.
CREATE TABLE IF NOT EXISTS maintenance_runs (
  name text PRIMARY KEY,
  last_completed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_expiry_idx ON email_tokens(expires_at,id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx ON password_reset_tokens(expires_at,id);
CREATE INDEX IF NOT EXISTS outbox_email_token_idx ON email_outbox(email_token_id) WHERE email_token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_password_reset_token_idx ON email_outbox(password_reset_token_id) WHERE password_reset_token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_terminal_history_idx ON email_outbox((coalesce(sent_at,created_at)),id) WHERE status IN ('SENT','FAILED');
CREATE INDEX IF NOT EXISTS outbox_terminal_security_idx ON email_outbox(created_at,id) WHERE status IN ('SENT','FAILED') AND kind IN ('VERIFY_EMAIL','PASSWORD_RESET');
