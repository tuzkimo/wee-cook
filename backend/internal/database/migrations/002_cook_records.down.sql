-- 回滚 002：先删索引 → 删列 → 删表。
DROP INDEX IF EXISTS idx_inventory_usages_cook;
DROP INDEX IF EXISTS idx_cook_records_recipe;
DROP INDEX IF EXISTS idx_cook_records_team;
DROP INDEX IF EXISTS idx_cook_records_server_seq;

ALTER TABLE inventory_usages DROP COLUMN IF EXISTS cook_id;

DROP TABLE IF EXISTS cook_records;
