DROP TRIGGER heartbeat_invalidates_days;
CREATE TRIGGER heartbeat_invalidates_days AFTER INSERT ON heartbeats BEGIN
  INSERT INTO daily_summaries(day)
    VALUES (date(NEW.time - 1800, 'unixepoch', '+8 hours'))
    ON CONFLICT(day) DO UPDATE SET version = version + 1;
  INSERT INTO daily_summaries(day)
    SELECT date(NEW.time + 1800, 'unixepoch', '+8 hours')
    WHERE date(NEW.time + 1800, 'unixepoch', '+8 hours') != date(NEW.time - 1800, 'unixepoch', '+8 hours')
    ON CONFLICT(day) DO UPDATE SET version = version + 1;
END;

UPDATE daily_summaries SET version = version + 1;
