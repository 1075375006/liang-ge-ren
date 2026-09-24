CREATE TABLE IF NOT EXISTS partner_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_email text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_invites_space_idx ON partner_invites(space_id, created_at DESC);
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS partner_invite_id uuid REFERENCES partner_invites(id);
CREATE INDEX IF NOT EXISTS outbox_partner_invite_idx ON email_outbox(partner_invite_id) WHERE partner_invite_id IS NOT NULL;
