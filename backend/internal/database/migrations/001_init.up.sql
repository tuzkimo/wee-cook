-- 初始表结构（规格 §7.2）：团队 + 范围列 + 库存两表
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SEQUENCE IF NOT EXISTS global_server_seq;

-- 照抄 wee-count：username 而非 email，头像只是一个 URL 字符串，本轮没有上传头像的界面
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 团队 = 家庭。团队列表只走 REST，不进同步载荷。
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 关系表：退组 / 移除就是删行，所以不带 id / updated_at / deleted_at（AGENTS.md 的确认例外）
CREATE TABLE team_members (
    team_id UUID NOT NULL REFERENCES teams(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

-- team_id 是范围：NULL = 个人菜谱（只有 owner_id 能看能改），否则团队成员共享
CREATE TABLE recipes (
    id TEXT PRIMARY KEY,                       -- 客户端生成的 UUID 字符串，不用 uuid 类型
    owner_id UUID NOT NULL REFERENCES users(id),
    team_id UUID REFERENCES teams(id),
    name TEXT NOT NULL,
    cover_path TEXT,                           -- 裸文件名，不是路径
    category_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- 三张子表没有 server_seq：它们跟着父菜谱整条走（§7.3），不做行级增量。
-- 三张子表也没有 deleted_at：服务端只保存「当前有效的子行快照」，软删的子行不参与同步
-- （AGENTS.md 已记录的确认例外）。本地 SQLite 侧这三张表照旧保留 deleted_at。
CREATE TABLE recipe_steps (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    sort_order INT,
    text TEXT,
    image_path TEXT
);

CREATE TABLE recipe_ingredients (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    ingredient_id TEXT,
    amount DOUBLE PRECISION,
    unit_id TEXT,
    sort_order INT
);

CREATE TABLE recipe_labels (
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL,
    PRIMARY KEY (recipe_id, label_id)
);

-- 字典表：没有同名唯一约束，去重靠「同范围内同名合并到旧 id」（§7.4），撞约束会让整批写入回滚。
-- 范围：team_id IS NULL 且 owner_id = 那个人 → 个人字典；team_id = T → 团队字典（owner_id 为空）。
CREATE TABLE ingredients (
    id TEXT PRIMARY KEY,
    team_id UUID REFERENCES teams(id),
    owner_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

CREATE TABLE units (
    id TEXT PRIMARY KEY,
    team_id UUID REFERENCES teams(id),
    owner_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    team_id UUID REFERENCES teams(id),
    owner_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- 库存：余量永远由「批次数量 − 未删除的使用记录」派生，不落列（库存设计 §4）。
-- 不建指向字典 / 菜谱的外键：字典同名合并会物理删行，真外键只会让同步卡死。
CREATE TABLE inventory_batches (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),   -- 录入者
    team_id UUID REFERENCES teams(id),             -- NULL = 个人库存
    ingredient_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    unit_id TEXT,
    produced_at TEXT,                              -- YYYY-MM-DD
    shelf_life_days INT,
    expires_at TEXT,                               -- YYYY-MM-DD
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- 使用记录只增不清：used_at 就是发生时间，不另设 created_at
CREATE TABLE inventory_usages (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),   -- 扣减者
    team_id UUID REFERENCES teams(id),             -- 与批次同值，服务端校验不一致就跳过
    recipe_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
    used_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- files 不参与鉴权：读权限看「有没有一条我可见的菜谱引用了它」（§8.1）
CREATE TABLE files (
    name TEXT PRIMARY KEY,                     -- "<uuid>.jpg"，客户端生成，全局唯一
    owner_id UUID NOT NULL REFERENCES users(id), -- 上传者，只用于排查与将来的 GC，不参与鉴权
    size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE INDEX idx_recipes_owner ON recipes(owner_id);
CREATE INDEX idx_recipes_team ON recipes(team_id);
CREATE INDEX idx_recipes_server_seq ON recipes(server_seq);
CREATE INDEX idx_recipes_cover_path ON recipes(cover_path);
CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id);
CREATE INDEX idx_recipe_steps_image_path ON recipe_steps(image_path);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX idx_ingredients_name ON ingredients(name);
CREATE INDEX idx_ingredients_team_name ON ingredients(team_id, name);
CREATE INDEX idx_ingredients_server_seq ON ingredients(server_seq);
CREATE INDEX idx_units_name ON units(name);
CREATE INDEX idx_units_team_name ON units(team_id, name);
CREATE INDEX idx_units_server_seq ON units(server_seq);
CREATE INDEX idx_labels_name ON labels(name);
CREATE INDEX idx_labels_team_name ON labels(team_id, name);
CREATE INDEX idx_labels_server_seq ON labels(server_seq);
CREATE INDEX idx_inventory_batches_server_seq ON inventory_batches(server_seq);
CREATE INDEX idx_inventory_batches_team ON inventory_batches(team_id);
CREATE INDEX idx_inventory_usages_server_seq ON inventory_usages(server_seq);
CREATE INDEX idx_inventory_usages_team ON inventory_usages(team_id);
CREATE INDEX idx_inventory_usages_batch ON inventory_usages(batch_id);
