CREATE TABLE heartbeats (
  id TEXT PRIMARY KEY,
  time REAL NOT NULL,
  machine TEXT NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  language TEXT NOT NULL,
  editor TEXT NOT NULL,
  project TEXT NOT NULL,
  operating_system TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX heartbeats_time ON heartbeats(time);
CREATE TABLE daily_summaries (
  day TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  computed_version INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE TRIGGER heartbeat_invalidates_days AFTER INSERT ON heartbeats BEGIN
  INSERT INTO daily_summaries(day)
    VALUES (date(NEW.time - 900, 'unixepoch', '+8 hours'))
    ON CONFLICT(day) DO UPDATE SET version = version + 1;
  INSERT INTO daily_summaries(day)
    SELECT date(NEW.time + 900, 'unixepoch', '+8 hours')
    WHERE date(NEW.time + 900, 'unixepoch', '+8 hours') != date(NEW.time - 900, 'unixepoch', '+8 hours')
    ON CONFLICT(day) DO UPDATE SET version = version + 1;
END;
