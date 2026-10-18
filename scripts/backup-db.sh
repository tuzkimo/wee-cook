#!/usr/bin/env bash
# 备份本仓库的 PostgreSQL 与 files 图片卷，滚动保留最近 N 天。建议交给 cron 每天跑。
#
# 用法：~/wee-cook/scripts/backup-db.sh
# 要改的只有下面「可调参数」那几行；默认值无需修改即可使用。
set -euo pipefail

# ====== 可调参数 ======
COMPOSE_DIR=$(cd "$(dirname "$0")/.." && pwd)   # compose.yml 所在目录（仓库根）；脚本放仓库 scripts/ 里就不用改
BACKUP_DIR=$HOME/backup/wee-cook   # 备份存哪
KEEP_DAYS=7                        # 保留最近几天
PG_SERVICE=postgres                # compose.yml 里的数据库服务名
API_SERVICE=api                    # 挂着图片卷的服务
# =====================

mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"   # 备份里有用户名等数据，不给别人读
cd "$COMPOSE_DIR"

STAMP=$(date +%F)
DB_TMP="$BACKUP_DIR/.wee-cook-$STAMP.sql.gz.tmp"
DB_OUT="$BACKUP_DIR/wee-cook-$STAMP.sql.gz"
FILES_TMP="$BACKUP_DIR/.wee-cook-files-$STAMP.tar.gz.tmp"
FILES_OUT="$BACKUP_DIR/wee-cook-files-$STAMP.tar.gz"

# 中途失败时清掉半成品，不让坏文件留在目录里冒充好备份
trap 'rm -f "$DB_TMP" "$FILES_TMP"' EXIT

# ---- 数据库 ----
# 用户名和库名直接取容器里的环境变量，不用在这里重复填
docker compose exec -T "$PG_SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$DB_TMP"

# 两道检查：① 压缩包本身没坏 ② 里面确实是一份 pg_dump 输出
# （第二道防的是「dump 悄悄产出一个空文件」，那种备份最坑人）
if ! gzip -t "$DB_TMP" || ! zcat "$DB_TMP" | grep -c 'PostgreSQL database dump' > /dev/null; then
  echo "$(date '+%F %T') 数据库备份自检失败：dump 不完整，已丢弃，未生成今天的备份" >&2
  exit 1
fi
mv "$DB_TMP" "$DB_OUT"

# ---- 图片卷 ----
# 卷名是 <compose 项目名>_files，随部署目录变，不能写死。
# 写错的后果不是报错，而是 docker 新建一个空卷、成功打包出一个空归档 —— 所以从运行中的容器反查真实卷名。
API_CID=$(docker compose ps -q "$API_SERVICE")
if [ -z "$API_CID" ]; then
  echo "$(date '+%F %T') $API_SERVICE 容器没在跑，先 docker compose up -d" >&2
  exit 1
fi
VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/files"}}{{.Name}}{{end}}{{end}}' "$API_CID")
if [ -z "$VOL" ]; then
  echo "$(date '+%F %T') 找不到 $API_SERVICE 上 /data/files 的挂载卷：检查 compose.yml 的 volumes 是否还是 files:/data/files" >&2
  exit 1
fi

# 借 postgres 容器自己的镜像来打包：它一定已在本地，不必为了备份再拉一个新镜像。
# 镜像都是 alpine 系，自带 busybox tar；tar 直接写标准输出，省掉把备份目录再挂进容器（文件也归跑脚本的用户所有）。
TAR_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q "$PG_SERVICE")")
docker run --rm -v "$VOL":/data "$TAR_IMAGE" tar czf - -C /data . > "$FILES_TMP"

if ! tar -tzf "$FILES_TMP" > /dev/null; then
  echo "$(date '+%F %T') 图片备份自检失败：tar 包不完整，已丢弃，未生成今天的备份" >&2
  exit 1
fi
mv "$FILES_TMP" "$FILES_OUT"

# +$((KEEP_DAYS-1)) 就是「保留 KEEP_DAYS 份」：删掉再早一天的
find "$BACKUP_DIR" -name 'wee-cook-*.sql.gz' -type f -mtime "+$((KEEP_DAYS-1))" -delete
find "$BACKUP_DIR" -name 'wee-cook-files-*.tar.gz' -type f -mtime "+$((KEEP_DAYS-1))" -delete

echo "$(date '+%F %T') OK 数据库 $DB_OUT $(du -h "$DB_OUT" | cut -f1) / 图片 $FILES_OUT $(du -h "$FILES_OUT" | cut -f1)"
