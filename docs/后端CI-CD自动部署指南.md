# 后端 CI/CD 自动部署指南

> 适用对象：这台服务器上已经在跑 wee-count，现在要把 wee-cook 的后端也放上去。整套流程已经配好（`.github/workflows/deploy-backend.yml` + `compose.yml` 的 `API_ADDR` 行），本文只讲**你还需要手动做的**和**日常怎么用**。

## 0. 这套流程做了什么

把后端代码 push 到 `main` 分支（且改动涉及 `backend/` 目录）后，GitHub 会自动：

```text
push 到 main
   │
   ▼
① 跑测试 (go test，会起真的 postgres 容器)
   │
   ▼
② 打包成 Docker 镜像，推到 GHCR（ghcr.io/tuzkimo/wee-cook-api）
   │
   ▼
③ SSH 登录服务器 → 拉新镜像 → 重启后端容器 → 打一次健康检查
   │
   ▼
线上后端自动更新，数据库迁移也随启动自动执行
```

**你平时唯一要做的，就是正常 `git push`，剩下的全自动。**

健康检查那一步是刻意加的：容器起来就崩（迁移失败、`.env` 写错）时 `docker compose up -d` 的退出码仍然是 0，不打这一枪这次部署会显示成绿色，等于假装成功。现在它会红，并把容器最近 50 行日志打出来。

## 1. 一次性准备（只做一次）

一共 4 步，每步都标了「在哪台机器上操作」。

### 1.1 生成 SSH 密钥 —— 在服务器

刻意跟 wee-count 用**分开的一把钥匙**：出事时只删 `authorized_keys` 里一行，不影响另一个项目。

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/wee-cook-deploy -N ''
cat ~/.ssh/wee-cook-deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

> 公钥留在服务器上，表示「允许持有对应私钥的人登录」；私钥复制一份填到 GitHub 给 Actions 用。因为公钥本来就要放进服务器，直接在服务器上生成最省事，本地电脑完全不参与。

然后查看私钥内容（马上要填到 GitHub）：

```bash
cat ~/.ssh/wee-cook-deploy
```

把输出**从头到尾完整复制**（包括 `-----BEGIN OPENSSH PRIVATE KEY-----` 和 `-----END ...-----` 这两行）。

### 1.2 配置 GitHub Secrets —— 在 GitHub 网页

打开 `tuzkimo/wee-cook` 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，依次添加 5 个：

| Name | 填什么 |
|------|--------|
| `DEPLOY_HOST` | 服务器公网 IP 或域名，**只要主机名**，不要端口、不要 `user@` |
| `DEPLOY_USER` | SSH 登录用户名，如 `tuzkimo` |
| `DEPLOY_PORT` | SSH 端口，如 `29876` |
| `DEPLOY_SSH_KEY` | 1.1 复制的私钥全文 |
| `DEPLOY_PATH` | 部署目录的**绝对路径**，如 `/home/tuzkimo/wee-cook`（compose 在仓库根，不是 `backend/`） |

> 路径放 secret 是因为它就是 `/home/<用户名>/...`，而用户名已经是 secret；那行明文写着就等于白藏。
> 代价知道一下：secret 在日志里会显示成 `***`，将来路径填错时看不到真实值，只能自己去服务器上 `pwd` 核对。

### 1.3 服务器准备部署目录 —— 在服务器

```bash
cd /home/tuzkimo
git clone git@github.com:tuzkimo/wee-cook.git    # 与 wee-count 平级，两个项目互不干扰
cd wee-cook
cp .env.example .env
```

编辑 `.env`，除了必填的三个密码，**这三段是这次部署的关键**：

```env
# 只绑本机回环，公网连 8081 都摸不到，只有 Caddy 能进。
# 必须与 .github/workflows/deploy-backend.yml 的 API_ADDR 一致。
API_ADDR=127.0.0.1:8081

# postgres / redis 的宿主侧端口要错开：wee-count 已经占着 5432 / 6379，
# 不换会报 "Bind for 127.0.0.1:6379 failed: port is already allocated"。
# 容器内部互相走服务名，这两个值只影响从宿主机连它们。
POSTGRES_ADDR=127.0.0.1:15432
REDIS_ADDR=127.0.0.1:16379

# 在 Caddy 之后：限流才会按真实客户端 IP 计，否则全世界共用一个配额。
TRUST_PROXY=true
```

其余注意：

- `POSTGRES_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET` 改成强随机值
- `CORS_ALLOWED_ORIGINS` **保持默认不动**——它校验的是 App webview 的来源（`http://tauri.localhost`），跟你挂的域名无关
- 端口本来会跟 wee-count 的 `8080` 撞车，`API_ADDR=127.0.0.1:8081` 正是为此

### 1.4 Caddy 反代 —— 在服务器

在 Caddyfile 里加一段（域名换成你自己的）：

```caddy
cook.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

```bash
caddy reload --config /etc/caddy/Caddyfile   # 或 systemctl reload caddy
```

> 镜像**不需要** `docker login ghcr.io`：wee-cook 是 public 仓库，GHCR 包跟随仓库可见性，匿名就能拉。（wee-count 那份指南里的 PAT 步骤是为私有包准备的，这里用不上。）

## 2. 首次上线

密钥和 `.env` 都就位后，在 GitHub → **Actions** → `deploy-backend` → **Run workflow**（`workflow_dispatch`）手动跑一次。

三个 job 依次变绿 ✓（test → build-push → deploy）即成功。deploy 里那条 `curl` 返回成功，说明线上 API 真在应答。

> ⏱ **首次部署很慢，不要当成卡死**。实测服务器到 `ghcr.io` 只有 ~13 KB/s，一个镜像层要十几分钟；
> 所以 workflow 里把 `command_timeout` 提到了 **45m**（默认 10m 会在拉取中途把 SSH 会话掉断，报错是 `Run Command Timeout`）。
> 后面同镜像的层已缓存在服务器上，日常部署只传变动的小层，快得多。
> 这条链路本身没有好办法提速：Docker 的 `registry-mirrors` 只作用于 Docker Hub，不适用于 ghcr，
> 真要加快只能给服务器挂代理。

然后验证：

```bash
curl https://cook.example.com/api/v1/healthz    # 期望 {"status":"ok"}
```

## 3. 日常使用

### 3.1 上线一次后端

```bash
git add backend
git commit -m "feat: 某某改动"
git push origin main
```

只要改动涉及 `backend/` 目录，部署就自动开始，**无需任何额外操作**。

### 3.2 查看部署结果

GitHub 仓库 → **Actions** → `deploy-backend` → 点进那次运行看日志。

### 3.3 App 对接

App「我的 → 多设备同步」，地址写到域名/端口为止，**不要**带 `/api/v1`（App 自己拼路径）：

```
https://cook.example.com
```

## 4. 出问题怎么办

### 4.1 定位失败在哪一步

- **test 失败**：代码没过测试，看日志改代码重新 push
- **build-push 失败**：打包镜像失败，看日志（多半是依赖或 `Dockerfile`）
- **deploy 失败**：SSH 连不上（`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_PORT` 填错、私钥不完整、公钥没进 `authorized_keys`），或健康检查没通过（下面会打容器日志）

### 4.2 回滚到上一个版本

最简单：把那次改动 `git revert` 掉再 push，自动部署回旧版。

也可以在服务器手动回滚到某次构建（每次构建还额外打了 sha 标签，在 Actions 的 build-push 日志里能找到）：

```bash
cd /home/tuzkimo/wee-cook
docker pull ghcr.io/tuzkimo/wee-cook-api:<那次的 sha>
# 临时把 compose.yml 的 image 行改成该 sha，然后：
docker compose up -d --no-build
```

### 4.3 改了 `compose.yml` 本身

**CI 只同步镜像，不同步 compose 文件。** 改了 compose（加服务、改环境变量、改端口）后要在服务器手动同步：

```bash
cd /home/tuzkimo/wee-cook && git pull
docker compose up -d --no-build
```

### 4.4 改了 `.env`

```bash
cd /home/tuzkimo/wee-cook && docker compose up -d
```

`up` 发现配置变了会重建容器；Go 只在进程启动时读环境变量，不重建等于没改。

## 5. 与 wee-count 的差异（排错时容易搞混的点）

| | wee-count | wee-cook |
|---|---|---|
| 部署目录 | `/home/tuzkimo/wee-count/backend` | `/home/tuzkimo/wee-cook`（compose 在仓库根） |
| 分支 | `master` | `main` |
| 公网端口 | 宿主 `8080` 直连 | 宿主 `127.0.0.1:8081` + Caddy |
| postgres / redis 宿主端口 | `5432` / `6379` | `15432` / `16379`（避开 wee-count） |
| 密钥 | `~/.ssh/wee-count-deploy` | `~/.ssh/wee-cook-deploy` |
| 健康检查 | 无 | 有（`/api/v1/healthz`） |
