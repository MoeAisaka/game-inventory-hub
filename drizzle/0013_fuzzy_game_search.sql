-- Custom SQL migration file, put your code below! --
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS games_name_zh_trgm_idx
  ON games USING gin (lower(name_zh) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS games_name_en_trgm_idx
  ON games USING gin (lower(name_en) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS steam_library_items_name_trgm_idx
  ON steam_library_items USING gin (lower(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS platform_library_items_name_trgm_idx
  ON platform_library_items USING gin (lower(name) gin_trgm_ops);
