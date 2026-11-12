-- 0030_phase2_utc.sql — pin the database session timezone to UTC so legacy
-- timestamptz partition literals are unambiguous. The partition maintenance
-- function also uses explicit AT TIME ZONE 'UTC' boundaries.
DO $utc$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END
$utc$;
