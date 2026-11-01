-- 制作记录成为真实体（制作记录设计 §4.2）：一次制作一条记录，使用记录用 cook_id 归属到它。
-- 形状与 inventory_batches 同构：team_id + owner_id 表达范围，server_seq 增量，created_at 由客户端给。
-- 不存作者昵称 / 头像：与 recipes 一样，只在响应里由 LEFT JOIN users 派生。
CREATE TABLE cook_records (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),
    team_id UUID REFERENCES teams(id),
    recipe_id TEXT NOT NULL,                     -- 不加外键：菜谱是软删，字典会被物理删
    created_at TIMESTAMPTZ NOT NULL,             -- 制作发生时间
    updated_at TIMESTAMPTZ NOT NULL,             -- LWW 比较
    deleted_at TIMESTAMPTZ,                      -- 本轮不写软删入口，为将来撤销留位
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- 允许 NULL 只为兼容已经存在的开发库；新写入一律带值。
ALTER TABLE inventory_usages ADD COLUMN cook_id TEXT;

CREATE INDEX idx_cook_records_server_seq ON cook_records(server_seq);
CREATE INDEX idx_cook_records_team ON cook_records(team_id);
CREATE INDEX idx_cook_records_recipe ON cook_records(recipe_id);
CREATE INDEX idx_inventory_usages_cook ON inventory_usages(cook_id);
