-- Email styles earned through a shared daily completion streak. Unlocks are
-- kept permanently once earned so a short break never takes away a reward.
CREATE TABLE IF NOT EXISTS email_template_unlocks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces(id) ON DELETE SET NULL,
  template_id text NOT NULL CHECK (template_id ~ '^[a-z0-9][a-z0-9-]*$'),
  streak_days integer NOT NULL CHECK (streak_days >= 0),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  PRIMARY KEY (user_id, template_id)
);
CREATE INDEX IF NOT EXISTS email_template_unlocks_space_idx
  ON email_template_unlocks(space_id, template_id);

-- Existing installations used a six-value CHECK constraint. New themed
-- templates are added by the application and still use a safe slug format.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_theme_check;
ALTER TABLE users ADD CONSTRAINT users_email_theme_check
  CHECK (email_theme ~ '^[a-z0-9][a-z0-9-]*$');
