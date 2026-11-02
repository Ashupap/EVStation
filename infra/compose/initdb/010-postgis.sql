-- EVStation's own database. Geospatial support is enabled at first init so
-- station discovery and trip planning can rely on PostGIS from the start.
CREATE EXTENSION IF NOT EXISTS postgis;
