# 自托管部署指南

WeeCook 后端是**可选**组件：不部署时 App 完全本地运行；部署后可在多设备、家庭成员之间同步菜谱与图片。

架构：一个 Docker Compose 拉起三个服务——`api`（Go）+ `postgres`（PostgreSQL 16）+ `redis`（Redis 7）。数据库迁移随 API 启动自动执行，无需手动操作。

## 前置要求

- 一台服务器（1C1G 起步足够）
- 已安装 Docker + Docker Compose（或 Podman）
- 开放入站端口 `8080`（API）。PostgreSQL/Redis 仅容器内通信并绑定 `127.0.0.1`，**不要**对公网开放

## 方式一：免克隆最小部署（镜像尚未发布，暂不可用）

> ⚠️ 预构建镜像 `ghcr.io/tuzkimo/wee-cook-api:latest` **尚未发布**（等仓库 CI 接上自动构建），
> 现在直接 `docker compose up -d` 会在拉镜像那一步失败。**当前请用「方式二：源码构建」**
> （`git clone` + `docker compose up -d --build`）。镜像发布后此节即可照用。

1. 在服务器上建一个目录（如 `wee-cook`），保存以下内容为 `compose.yml`：

```yaml
services:
  api:
    image: ghcr.io/tuzkimo/wee-cook-api:latest
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-wee}:${POSTGRES_PASSWORD:-wee}@postgres:5432/${POSTGRES_DB:-wee-cook}?sslmode=disable
      REDIS_URL: redis:6379
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD must be set}
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set}
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-http://tauri.localhost}
      # 服务位于可信反向代理（Caddy 等）之后时设为 true；直连暴露 8080 时保持 false（默认）。
      TRUST_PROXY: ${TRUST_PROXY:-false}
      FILES_DIR: /data/files
    volumes: [files:/data/files]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-wee}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-wee}
      POSTGRES_DB: ${POSTGRES_DB:-wee-cook}
    ports: ["127.0.0.1:5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-wee} -d ${POSTGRES_DB:-wee-cook}"]
      interval: 3s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}"]
    ports: ["127.0.0.1:6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
  files:
```

2. 同目录创建 `.env`（**务必改掉这两个必填值**）：

```env
REDIS_PASSWORD=<改成强密码>
JWT_SECRET=<改成随机长字符串>
```

3. 启动并验证（`curl` 返回 `{"status":"ok"}` 即 API 正常）：

```bash
docker compose up -d
curl http://<服务器IP>:8080/api/v1/healthz
```

## 方式二：源码构建

```bash
git clone https://github.com/tuzkimo/wee-cook.git
cd wee-cook
cp .env.example .env    # 填 REDIS_PASSWORD 与 JWT_SECRET
docker compose up -d --build
```

仓库根目录自带 `compose.yml`，`api` 服务同时写了 `build: ./backend` 与 `image: ghcr.io/...`。
`up` 会优先使用 `image:` 指的镜像（本地没有则拉取）；`docker compose up -d --build` 会本地构建并按同一个 `image:` 名打标签。想在本地测自己的改动，用 `--build` 即可。

## 环境变量

`DATABASE_URL` / `REDIS_URL` 不需要手填——compose 用容器服务名拼好默认值透传给 API。

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `REDIS_PASSWORD` | 是 | — | Redis 密码 |
| `JWT_SECRET` | 是 | — | JWT 签名密钥，随机长字符串 |
| `POSTGRES_PASSWORD` | 否 | `wee` | PostgreSQL 密码，建议改掉 |
| `POSTGRES_USER` | 否 | `wee` | PostgreSQL 用户 |
| `POSTGRES_DB` | 否 | `wee-cook` | 数据库名 |
| `CORS_ALLOWED_ORIGINS` | 否 | `http://tauri.localhost` | 允许的来源，逗号分隔，需含 scheme |
| `TRUST_PROXY` | 否 | `false` | 是否信任反代转发的 `X-Forwarded-For` |

> 监听端口固定 `8080`（compose 端口映射写死）；单张图片上限固定 5MB。本表只列 compose 真正会透传给容器的变量。

> **限流信任模型**：登录/注册、以及邀请码加入团队（`/teams/join`）均按 IP 限流 10 次/分钟。`TRUST_PROXY=false`（默认）时取 socket peer 地址，客户端无法伪造；仅当 API 位于可信反向代理之后时设 `true`，否则攻击者可伪造 `X-Forwarded-For` 绕过限流。

## App 对接

在 App「我的」页 → 「多设备同步」→ 填入**服务器地址**（地址写到端口为止，**不要**带 `/api/v1`，App 自己会拼路径）：

```
http://<服务器IP>:8080

# 前置 HTTPS 反代时：
https://<你的域名>
```

保存前 App 会先请求 `<地址>/api/v1/healthz` 探活，返回成功才能保存。保存后在同一页登录或注册，
再在「我的家庭」里建家庭、用邀请码拉家人进来。操作说明见 [README](../README.md)，
实现细节与排查见 [同步与团队](开发者-同步与团队.md)。

## HTTPS（生产建议）

前置 nginx/Caddy 反向代理 + Let's Encrypt，或 Cloudflare Tunnel。此时：

- `CORS_ALLOWED_ORIGINS` 保持 `http://tauri.localhost` 不变——CORS 校验的是 App webview 来源，与后端域名无关
- `TRUST_PROXY=true`（限流取真实客户端 IP）

## 升级

**方式一（免克隆/镜像）**：

```bash
docker compose pull api
docker compose up -d
```

**方式二（源码构建）**：

```bash
git pull
docker compose up -d --build
```

数据库迁移随新版本启动自动执行。

## 备份

菜谱与图片存在数据卷里，建议定期备份。

```bash
# 数据库（cron 建议；cron 无 TTY，必须加 -T，否则 `docker compose exec` 会报 TTY 错误）
docker compose exec -T postgres pg_dump -U wee wee-cook > wee-cook-$(date +%F).sql

# 恢复
cat wee-cook-2026-10-14.sql | docker compose exec -T postgres psql -U wee wee-cook

# 图片：备份 files 卷
docker run --rm -v wee-cook_files:/data -v "$PWD":/backup alpine tar czf /backup/wee-cook-files-$(date +%F).tar.gz -C /data .
```

> 若服务器数据库被重建（`docker compose down -v`）或恢复了一份较旧的备份：服务端已加世代护栏，
> 客户端首次同步会自动全量重拉；但账号行若不在新库里，客户端需要**重新登录**（`/me` 返回 401
> → 刷新令牌也失败 → 登出重新注册，新账号从零开始同步）才能恢复。

以上命令假设 `.env` 使用默认的 `POSTGRES_USER=wee`、`POSTGRES_DB=wee-cook`；若你改过这两个值，请对应替换命令中的 `-U wee` 与库名。

图片卷名是 **`<compose 项目名>_files`**，项目名默认取自 `compose.yml` 所在目录名（目录叫 `recipes` 时卷名就是 `recipes_files`）。写错卷名不会报错——`docker run -v` 会**新建一个空卷**并成功打包出空归档。执行前先确认真实卷名：

```bash
docker volume ls | grep files
```

确认后把上面命令里的卷名换成它（例如 `-v recipes_files:/data`）。

## 数据与隐私

请如实告知使用者：

- **服务器以明文保存菜谱与图片**（PostgreSQL 里的菜谱内容、`files` 卷里的图片文件）。没有端到端加密，也没有静态加密；能登上这台服务器的人就能看到全部内容。敏感菜谱不要放上去。
- **数据在你自己机器上**。这个后端是给你自己（或你的家人）自托管的，没有官方服务器、没有第三方账号，注册的账号只存在于你的数据库里。
- **图片存在 `files` 命名卷**（容器内 `/data/files`）。`docker compose down` / 重建容器不会丢图；**`docker compose down -v` 会连卷一起删掉**，别加 `-v`。
- **删菜谱不会删图片**：图片按文件名存储、可被多道菜谱复用，服务器暂未做引用计数与垃圾回收。删掉菜谱后图片仍留在 `files` 卷里、仍能通过 `/api/v1/files/{name}` 取到（取权限由「还有菜谱引用它」决定）。磁盘占满时请自行清理该卷。
- 服务端**没有**任何第三方上报、分析或外发。
