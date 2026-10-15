# AGENTS.md

## 项目概述

一起做饭（WeeCook）— 离线优先、家庭/社区共享的菜谱管理 App，移动端（Android）优先。
- 前端：Vue 3 + TypeScript + Vite
- 客户端壳：Tauri 2.0（桌面端仅用于开发调试，Android 为正式目标平台）
- 本地存储：SQLite（`@tauri-apps/plugin-sql`）
- 后端：暂无。后期自托管 Go 服务，用于 AI 截图收录与多设备同步

## 开发命令

```bash
# 前端
npm run dev              # 启动 Vite 开发服务器
npm run build            # vue-tsc 类型检查 + Vite 构建

# Tauri 桌面端（开发调试用）
npm run tauri dev

# Tauri Android 端
npm run tauri android dev     # 编译 + 推送到已连接的 Android 设备
npm run tauri android build   # 构建发布包 (.apk)

# 验证
npm run test             # 前端单元测试（vitest）
cargo check              # Rust 类型检查（不编译，快）
cargo clippy             # Rust lint
```

## 技术约束

- 不重构无关代码，不要修改未被明确要求的文件。
- 测试优先：非 bugfix 类功能实现需附带单元测试，不可删改已有测试。
  - 例外：已有断言与**新的规格要求直接冲突**时，**经人工确认可修改**（禁止为让代码变绿而放宽、删除或改弱断言）。
- TypeScript 严格模式，禁止 `any`。
- **食材必须引用结构化数据**：菜谱只存 `ingredient_id` + 用量 + `unit_id`，禁止在菜谱表里存食材纯文本；别名（"五花肉"/"三层肉"）由食材表归一。
- **每张业务表带 `id`、`updated_at`、`deleted_at`**，为后期的 LWW 增量同步与软删除留位。
  - 例外（2026-10-14 确认）：**服务端的三张子表 `recipe_steps` / `recipe_ingredients` / `recipe_labels` 不带 `deleted_at`**。它们不是独立业务实体，而是随父菜谱整条替换的快照（服务端只存当前有效的子行，软删子行不下发），加一个永远为 NULL 的列没有意义。本地 SQLite 侧这三张表照旧保留 `deleted_at`。见 `docs/superpowers/specs/2026-10-14-sync-team-design.md` §7.3 / §11.13。
  - 例外（2026-10-15 确认）：**服务端的 `favorites` / `follows` 与本地 `favorite_recipes` 不带 `id` / `updated_at` / `deleted_at`**（本地 `local_accounts` 同理）。它们不是业务实体，而是「一方的订阅关系」或本机设备状态：只由本人改写，服务端每次同步全量下发、客户端整表替换，取消订阅就是删行，软删与 LWW 都用不上。见 `docs/superpowers/specs/2026-10-15-community-design.md` §7.2 / §12。
- **README.md 只写普通用户要看的内容**（做什么、怎么装、怎么用）；开发者文档另起文件放 `docs/`（架构、数据模型、构建发布），不往 README 里塞。
