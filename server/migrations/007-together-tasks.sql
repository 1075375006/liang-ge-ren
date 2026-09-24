ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_mode_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_mode_check CHECK (mode IN ('ASSIGNED', 'RACE', 'TOGETHER'));
ALTER TABLE tasks ADD CONSTRAINT tasks_check CHECK (
  (mode = 'ASSIGNED' AND assigned_to IS NOT NULL) OR
  (mode IN ('RACE', 'TOGETHER') AND assigned_to IS NULL)
);
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_mode_check;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_check;
ALTER TABLE schedules ADD CONSTRAINT schedules_mode_check CHECK (mode IN ('ASSIGNED', 'RACE', 'TOGETHER'));
ALTER TABLE schedules ADD CONSTRAINT schedules_check CHECK (
  (mode = 'ASSIGNED' AND assigned_to IS NOT NULL) OR
  (mode IN ('RACE', 'TOGETHER') AND assigned_to IS NULL)
);
