CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  email text UNIQUE,
  password_hash text,
  email_verified boolean NOT NULL DEFAULT false,
  notify_email boolean NOT NULL DEFAULT false,
  email_theme text NOT NULL DEFAULT 'strawberry' CHECK (email_theme IN ('strawberry','cream','mint','sky','lavender','night')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  app_id text NOT NULL,
  provider_uid text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, app_id, provider_uid),
  UNIQUE(provider, app_id, user_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  browser_hash text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('login','bind')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_hash text,
  app_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  invite_code text UNIQUE,
  invite_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  space_id uuid NOT NULL REFERENCES spaces(id),
  slot smallint NOT NULL CHECK (slot IN (1, 2)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(space_id, slot)
);
CREATE TABLE IF NOT EXISTS email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  assigned_to uuid REFERENCES users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  reward integer NOT NULL CHECK (reward BETWEEN 1 AND 10000),
  mode text NOT NULL CHECK (mode IN ('ASSIGNED', 'RACE')),
  kind text NOT NULL CHECK (kind IN ('ONCE', 'DAILY', 'WEEKLY')),
  run_at timestamptz,
  time text,
  weekday smallint CHECK (weekday BETWEEN 1 AND 7),
  duration_hours integer NOT NULL CHECK (duration_hours BETWEEN 1 AND 168),
  active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'ASSIGNED' AND assigned_to IS NOT NULL) OR (mode = 'RACE' AND assigned_to IS NULL)),
  CHECK ((kind = 'ONCE' AND run_at IS NOT NULL) OR (kind IN ('DAILY','WEEKLY') AND time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
  CHECK (kind <> 'WEEKLY' OR weekday IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(next_run_at) WHERE active;
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  assigned_to uuid REFERENCES users(id),
  claimant_id uuid REFERENCES users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  reward integer NOT NULL CHECK (reward BETWEEN 1 AND 10000),
  mode text NOT NULL CHECK (mode IN ('ASSIGNED', 'RACE')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLAIMED','SUBMITTED','APPROVED','CANCELLED','EXPIRED')),
  submission text,
  review_note text,
  reviewed_by uuid REFERENCES users(id),
  due_at timestamptz,
  submitted_at timestamptz,
  approved_at timestamptz,
  schedule_id uuid REFERENCES schedules(id),
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id, scheduled_for),
  CHECK ((mode = 'ASSIGNED' AND assigned_to IS NOT NULL) OR (mode = 'RACE' AND assigned_to IS NULL)),
  CHECK (status NOT IN ('CLAIMED','SUBMITTED','APPROVED') OR claimant_id IS NOT NULL),
  CHECK (reviewed_by IS NULL OR reviewed_by <> claimant_id)
);
CREATE INDEX IF NOT EXISTS tasks_space_created_idx ON tasks(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_expiry_idx ON tasks(due_at) WHERE status IN ('OPEN','CLAIMED');
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id),
  creator_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  emoji text NOT NULL DEFAULT '🎁',
  price integer NOT NULL CHECK (price BETWEEN 1 AND 100000),
  stock integer NOT NULL CHECK (stock >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_space_idx ON products(space_id, created_at DESC);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES products(id),
  title text NOT NULL,
  description text NOT NULL,
  price integer NOT NULL CHECK (price > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FULFILLED','COMPLETED','CANCELLED')),
  idempotency_key text NOT NULL,
  fulfilled_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(buyer_id, idempotency_key),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX IF NOT EXISTS orders_space_idx ON orders(space_id, created_at DESC);
CREATE TABLE IF NOT EXISTS point_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  space_id uuid NOT NULL REFERENCES spaces(id),
  delta integer NOT NULL CHECK (delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  source_key text NOT NULL UNIQUE,
  task_id uuid REFERENCES tasks(id),
  order_id uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON point_ledger(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  space_id uuid NOT NULL REFERENCES spaces(id),
  title text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL DEFAULT 'GENERAL',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  space_id uuid REFERENCES spaces(id),
  notification_id uuid UNIQUE REFERENCES notifications(id),
  email_token_id uuid REFERENCES email_tokens(id),
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL DEFAULT 'GENERAL',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON email_outbox(next_attempt_at) WHERE status IN ('PENDING','SENDING');
CREATE INDEX IF NOT EXISTS outbox_user_idx ON email_outbox(user_id);
CREATE TABLE IF NOT EXISTS worker_heartbeat (
  name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS email_token_id uuid REFERENCES email_tokens(id);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_theme text NOT NULL DEFAULT 'strawberry' CHECK (email_theme IN ('strawberry','cream','mint','sky','lavender','night'));
-- Early local databases capped stored stock as well as manual input. Refunds must
-- still succeed after a seller replenishes stock to the manual-input maximum.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass AND conname = 'products_stock_check'
      AND pg_get_constraintdef(oid) LIKE '%100000%'
  ) THEN
    ALTER TABLE products DROP CONSTRAINT products_stock_check;
    ALTER TABLE products ADD CONSTRAINT products_stock_check CHECK (stock >= 0);
  END IF;
END $$;
