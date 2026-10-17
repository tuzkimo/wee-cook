# 自托管部署指南

WeeCook 后端是**可选**组件：不部署时 App 完全本地运行；部署后可在多设备之间同步菜谱与图片，并把菜谱公开到本服务器的社区。

共享模型是**社区**，不是团队：菜谱默认私有，作者手动公开后**本服务器所有登录用户**都能浏览、详情与看封面，并可以收藏与关注作者。没有团队、没有邀请码、没有多本菜谱。

架构：一个 Docker Compose 拉起三个服务——`api`（Go）+ `postgres`（PostgreSQL 16）+ `redis`（Redis 7）。数据库迁移随 API 启动自动执行，无需手动操作。

## 前置要求

- 一台服务器（1C1G 起步足够）
- 已安装 Docker + Docker Compose（或 Podman）
- 开放入站端口 `8080`（API）。PostgreSQL/Redis 仅容器内通信并绑定 `127.0.0.1`，**不要**对公网开放

> 同一台机器上已有一套 wee-count 占着 `8080`，或者前面要挂 Caddy 反代时，宿主侧地址可改：
> 把 `api` 的 `ports` 写成 `"${API_ADDR:-8080}:8080"`，`.env` 里填 `API_ADDR=127.0.0.1:8081`。
> 详见 [后端 CI/CD 自动部署指南](后端CI-CD自动部署指南.md)。

## 方式一：免克隆最小部署（用预构建镜像）

> 预构建镜像 `ghcr.io/tuzkimo/wee-cook-api:latest` 由 CI 在每次 push 到 `main` 时自动发布，
> 仓库是 public，匿名即可拉取。下面这段 compose 与仓库根目录的 `compose.yml` 内容基本一致
> （那份额外带 `build: ./backend`，并用 `API_ADDR` 覆盖宿主侧地址）。
> 想在服务器上接自动部署，见 [后端 CI/CD 自动部署指南](后端CI-CD自动部署指南.md)。

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
      AI_API_KEY: ${AI_API_KEY:-}
      AI_BASE_URL: ${AI_BASE_URL:-}
      AI_MODEL: ${AI_MODEL:-}
      AI_MAX_TOKENS: ${AI_MAX_TOKENS:-}
      AI_TIMEOUT: ${AI_TIMEOUT:-}
      AI_RATE_LIMIT: ${AI_RATE_LIMIT:-}
      AI_DAILY_LIMIT: ${AI_DAILY_LIMIT:-}
      # 供应商需经代理访问时填；留空 = 直连
      HTTP_PROXY: ${AI_HTTP_PROXY:-}
      HTTPS_PROXY: ${AI_HTTPS_PROXY:-}
      NO_PROXY: ${AI_NO_PROXY:-localhost,127.0.0.1,postgres,redis}
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

> 若前面挂 Caddy/nginx 反代或端口冲突，把 `api` 的 `ports` 改成 `"${API_ADDR:-8080}:8080"`，
> 并在 `.env` 里写 `API_ADDR=127.0.0.1:8081` 与 `TRUST_PROXY=true`。

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
| `POSTGRES_PASSWORD` | 否 | `wee`（不填时 compose 的回退值；`.env.example` 模板给的是 `change-me`） | PostgreSQL 密码，建议改掉。**只在首次 `docker compose up`、数据卷为空时生效**；之后改这个值不会生效（报 `password authentication failed for user "wee"`）——要么 `docker compose down -v` 删卷重建，要么把值改回旧的 |
| `POSTGRES_USER` | 否 | `wee` | PostgreSQL 用户 |
| `POSTGRES_DB` | 否 | `wee-cook` | 数据库名 |
| `CORS_ALLOWED_ORIGINS` | 否 | `http://tauri.localhost` | 允许的来源，逗号分隔，需含 scheme |
| `TRUST_PROXY` | 否 | `false` | 是否信任反代转发的 `X-Forwarded-For` |

> 监听端口固定 `8080`（compose 端口映射写死）；单张图片上限固定 5MB。本表只列 compose 真正会透传给容器的变量。

> **限流信任模型**：登录/注册按 IP 限流 10 次/分钟。`TRUST_PROXY=false`（默认）时取 socket peer 地址，客户端无法伪造；仅当 API 位于可信反向代理之后时设 `true`，否则攻击者可伪造 `X-Forwarded-For` 绕过限流。

AI 相关变量见下一节。

## 启用 AI（可选）

AI 有两条链路：**聊天检索**（一句话筛本地菜谱）与**长截图收录**（截图 → 识别 → 预填编辑页）。
两者都经本服务器**代理**转发给你选的上游模型：key 只存在服务器上、客户端不碰；**文本检索**换供应商只改服务器上的两个环境变量、App 不用重新发版（截图链路还要重核下面的常量）。

> **截图收录已可用**：App 里选图或从相册/小红书分享到「一起做饭」，长图会在客户端分段后一次发往服务器。
> 下面的视觉模型要求与像素归一常量对它同样生效，换上游时逐条核。

**不配 `AI_API_KEY` 时 AI 功能整体关闭，服务照常启动**（`docker compose up` 不会因此失败）。启用：

1. 在 `.env` 里填 `AI_API_KEY`
2. `docker compose up -d`（改过 `.env` 需要重建容器才会读到新值）
3. 在 App「我的 → AI 菜谱助手」打开 AI 开关（默认关闭）。开关没打开时 App 里不会出现 AI 入口

### AI 环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `AI_API_KEY` | 否 | — | 上游 API key。**为空即整条 AI 管道关闭**（`GET /api/v1/ai/status` 报 disabled），不阻塞启动 |
| `AI_BASE_URL` | 否 | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址（只支持 `/chat/completions` 协议） |
| `AI_MODEL` | 否 | `deepseek-flash` | 模型名，见下方提醒 |
| `AI_MAX_TOKENS` | 否 | `1024` | 单次回复的最大 token 数 |
| `AI_TIMEOUT` | 否 | `120s` | 等待上游回复的超时；长截图视觉推理较慢，不要调小 |
| `AI_RATE_LIMIT` | 否 | `20` | 每用户**每分钟**请求上限 |
| `AI_DAILY_LIMIT` | 否 | `200` | 每用户**每天**请求上限 |
| `AI_HTTP_PROXY` / `AI_HTTPS_PROXY` | 否 | 空（= 直连） | 容器出网代理，映射到容器内的 `HTTP_PROXY` / `HTTPS_PROXY`。本地与线上都可能需要，地址各自填 |
| `AI_NO_PROXY` | 否 | `localhost,127.0.0.1,postgres,redis` | 不走代理的地址（别把数据库、Redis 也塞进代理） |

> ⚠️ **`AI_MODEL` 必须同时支持 tool calls 与 `image_url` 图片输入**：
> `deepseek-flash`（V4.1-Flash）两者都支持；`deepseek-chat` **不支持图片**，照抄它会让截图收录一上传就 400。
> 聊天检索只需要 tool calls，截图收录两条都要。

客户端与后端共识常量（部署端无需配置，但换上游时要核对）：请求体上限 **12 MiB**（后端闸门，超了返 413，客户端没有对应开关）、单段压缩后 **1 MiB**、一次请求最多 **7 段**。

### 上游需要经代理访问时

`api.deepseek.com` 这类域名在部分网络里必须经代理才能访问。后端走的是 Go 默认的 HTTP 传输层，
它**自动遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`**，所以只要把这三个变量给到进程即可，没有额外开关：

- **容器部署**：在 `.env` 里填 `AI_HTTP_PROXY` / `AI_HTTPS_PROXY` / `AI_NO_PROXY`（`compose.yml` 已把它们映射成容器内的三个标准变量），改完 `docker compose up -d` 重建容器
- **本地直跑**（要在真机上联调而不经容器时常见）：在启动后端的那个 shell 里设标准变量名，例如
  PowerShell `$env:HTTPS_PROXY="http://127.0.0.1:7890"`、bash `export HTTPS_PROXY=http://127.0.0.1:7890`；`.env` 里那三个 `AI_*_PROXY` 只对容器生效，对直跑无效
- **容器要访问宿主机上的代理**：Docker Desktop 用 `http://host.docker.internal:<端口>`；Linux 上 `host.docker.internal` 不可用，填网桥网关或内网代理地址
- **`NO_PROXY` 别漏**：默认值已含 `postgres` / `redis`，把数据库、Redis 也塞进代理会连不上
- **改完要重启进程**：Go 只在进程启动时读一次代理环境变量，热改 `.env` 或 shell 变量都不生效

代理不通时的表现是 `502 ai_unreachable` 或 `504 ai_upstream_timeout`（App 里分别是「连不上 AI 服务器」与「AI 等太久了」），
先查代理地址与 `NO_PROXY`，再查 `AI_BASE_URL` 域名。

### 限流口径

两条限流都**按用户（登录 userID）计**，不是按 IP、也不是全服务器共享：

- `AI_RATE_LIMIT` 是分钟级滑动窗口，`AI_DAILY_LIMIT` 是 24 小时滑动窗口（**不是自然日零点重置**），分钟级先判、日配额后判
- 计数放在**进程内存**里，**没有落 Redis**：多实例 / 多副本部署时每个实例各算一份，实际配额被放大到 `实例数 × 配置值`，重启实例会清零。自托管单实例按配置值生效
- `GET /api/v1/ai/status` 不吃日配额

### 换供应商 / 换模型要重新核对什么

「只改两个环境变量」对**文本检索**是真的。**截图链路还有几样是绑在上游身上的**，换模型时逐条核一遍，别只改 `AI_MODEL`
（摘自[设计规格 §6.1](superpowers/specs/2026-10-16-ai-recipe-design.md)）：

1. **视觉支持**：新模型必须接受 OpenAI 兼容的 `image_url` 内容块（含 `data:` URL）。这是事实标准，但不是每家的每个模型都有——`deepseek-v4-pro` 就没有
2. **工具调用**：两条链路都靠它，国内模型对 tool calling 的支持参差。换模型后先拿一个 `search_recipes` 的 few-shot 手动跑通，再改生产配置
3. **像素归一规则**：客户端把长图按宽度缩放到 1080px、每段不超过 1500px，是**从当前上游「总像素归一到 1300×1300」反推出来的**。不同供应商的归一阈值不同（常见的有 1120×1120、固定 768px 切块等），换了上游就得**重新算这两个常量**（在客户端代码里，需要重新发版）
4. 顺带核一眼单图体积 / 单边像素 / 每请求图片数上限有没有比我们（请求体 12 MiB / 单段 1 MiB / 单边 1080×1500px / 7 段）更紧的

> 第 3 条最容易漏：**它不会报错，只是识别质量静默下降**。

## App 对接

在 App「我的」页 → 「多设备同步」→ 填入**服务器地址**（地址写到端口为止，**不要**带 `/api/v1`，App 自己会拼路径）：

```
http://<服务器IP>:8080

# 前置 HTTPS 反代时：
https://<你的域名>
```

保存前 App 会先请求 `<地址>/api/v1/healthz` 探活，返回成功才能保存。保存后在同一页登录或注册，
之后就能在多台设备上登同一个账号同步了。

### 社区口径（部署前须知）

- **菜谱默认私有**：不公开的菜谱只发给作者本人及其自己的设备，同服务器的其他账号看不到。
- **公开是作者自己的动作**：在菜谱详情里打开「公开到社区」，这条菜谱就**对同服务器所有登录用户可见**
  （社区列表、详情、封面图）。取消公开后不再下发正文，但它仍留在收藏过它的人的本机，要到下一次同步才清掉。
- **没有团队 / 邀请码 / 菜谱本**：公开范围就到服务器为止，没有跨服务器发现，也没有「只分享给某几个人」。
- **收藏与关注只走 REST 接口，离线不可用**（按钮灰着，不做离线暂存）：
  `GET /community/recipes`、`GET /community/recipes/{id}`、`GET /users/{id}`、
  `POST|DELETE /favorites/{recipe_id}`、`POST|DELETE /follows/{user_id}`（均在 `/api/v1` 下，需登录）。
  收藏一条菜谱后，客户端会自动同步一次把正文与图片拉下来。
- **字典（食材 / 单位 / 分类 / 标签）是全服务器共享一份**：任何登录用户都能改别人建的食材名，
  自托管假设是「服务器属可信域」。

操作说明见 [README](../README.md)，
实现细节与排查见 [同步与社区](开发者-同步与社区.md)。

## HTTPS（生产建议）

前置 nginx/Caddy 反向代理 + Let's Encrypt，或 Cloudflare Tunnel。此时：

- `CORS_ALLOWED_ORIGINS` 保持 `http://tauri.localhost` 不变——CORS 校验的是 App webview 来源，与后端域名无关
- `TRUST_PROXY=true`（限流取真实客户端 IP）

## 升级

**方式一（免克隆/镜像）**：

```bash
# --no-build：compose.yml 里带 build: ./backend，不加这个可能在服务器上现场编译一遍
docker compose pull api
docker compose up -d --no-build
```

已接 CI/CD 的服务器（见 [后端 CI/CD 自动部署指南](后端CI-CD自动部署指南.md)）push 到 `main` 就自动更新，无需手动执行本节。

**注意**：升级只换镜像，**不会**同步 `compose.yml`。改过 compose（加服务、改环境变量、改端口）仍需手动 `git pull` 后 `docker compose up -d --no-build`。
**方式二（源码构建）**：

```bash
git pull
docker compose up -d --build
```

数据库迁移随新版本启动自动执行——**但只执行「版本号还没跑过」的那些**。

> ⚠️ 从团队版（2026-10-14 那版）升级到社区版要特别当心：本版把 `001_init` 的迁移内容**原地改写**了（删掉 `teams` / `team_members`，`recipes.team_id` 换成 `is_public`，新增 `favorites` / `follows`），而**版本号仍是 1**。`golang-migrate` 因此认为它已经应用过、不会重跑，升级后服务启动会报 `column "is_public" does not exist`。
>
> 这种升级必须重建数据库（**先按下一节备份**）：
>
> ```bash
> docker compose down -v   # ⚠️ 会连 pgdata 与 files 两个卷一起删掉，菜谱与图片都没了
> docker compose up -d --build
> ```
>
> 改写过迁移内容的版本之间不做原地升级兼容。

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

- **服务器以明文保存菜谱与图片**（PostgreSQL 里的菜谱内容、`files` 卷里的图片文件）。没有端到端加密，也没有静态加密；能登上这台服务器的人就能看到全部内容（包括所有公开菜谱）。敏感菜谱不要放上去，也不要公开。
- **数据在你自己机器上**。这个后端是给你自己（或你信任的一小群人）自托管的，没有官方服务器、没有第三方账号，注册的账号只存在于你的数据库里。
- **启用 AI 后，用户的数据会离开这台服务器**：提问原文、分类与标签名称、命中的菜谱名称与食材名，以及**整张截图**（可能包含账号昵称、点赞数等页面上的其他信息）都会发给你配的上游供应商。App 内隐私开关默认关闭，打开前会先展示这段说明。
- **图片存在 `files` 命名卷**（容器内 `/data/files`）。`docker compose down` / 重建容器不会丢图；**`docker compose down -v` 会连卷一起删掉**，别加 `-v`。
- **删菜谱不会删图片**：图片按文件名存储、可被多道菜谱复用，服务器暂未做引用计数与垃圾回收。删掉菜谱后图片仍留在 `files` 卷里，但只剩作者自己还能通过 `/api/v1/files/{name}` 取到（别人取不了，成了孤儿图）；磁盘占满时请自行清理该卷。
- 服务端**没有**任何第三方上报、分析或外发。
