-- 初始表结构（规格 §6.2）
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

CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE team_members (
    team_id UUID REFERENCES teams(id),
    user_id UUID REFERENCES users(id),
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE recipes (
    id TEXT PRIMARY KEY,                       -- 客户端生成的 UUID 字符串，不用 uuid 类型
    owner_id UUID NOT NULL REFERENCES users(id),
    team_id UUID REFERENCES teams(id),         -- NULL = 私人
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

-- 字典表：没有同名唯一约束，去重靠「同名合并到旧 id」（§7.4），撞约束会让整批写入回滚
CREATE TABLE ingredients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

CREATE TABLE units (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

-- files 没有 team_id：读权限不看这张表，看「有没有一条我可见的菜谱引用了它」（§8.1）
CREATE TABLE files (
    name TEXT PRIMARY KEY,                     -- "<uuid>.jpg"，客户端生成，全局唯一
    owner_id UUID NOT NULL REFERENCES users(id), -- 上传者，只用于排查与将来的 GC，不参与鉴权
    size BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recipes_team ON recipes(team_id);
CREATE INDEX idx_recipes_owner ON recipes(owner_id);
CREATE INDEX idx_recipes_server_seq ON recipes(server_seq);
CREATE INDEX idx_recipes_cover_path ON recipes(cover_path);
CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id);
CREATE INDEX idx_recipe_steps_image_path ON recipe_steps(image_path);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX idx_ingredients_name ON ingredients(name);
CREATE INDEX idx_ingredients_server_seq ON ingredients(server_seq);
CREATE INDEX idx_units_name ON units(name);
CREATE INDEX idx_units_server_seq ON units(server_seq);
CREATE INDEX idx_labels_name ON labels(name);
CREATE INDEX idx_labels_server_seq ON labels(server_seq);
CREATE INDEX idx_team_members_user ON team_members(user_id);
