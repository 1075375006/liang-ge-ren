-- Persist request identities alongside the business records they create.
-- No raw form content is stored here, only a hash of the normalized payload.
CREATE TABLE IF NOT EXISTS creation_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('task','schedule','product')),
  request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 8 AND 128),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,space_id,kind,request_key)
);
