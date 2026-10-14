package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// syncWriteLockID 是同步写事务的全局 advisory lock 编号：一次只允许一个同步写事务在途，
// 使 nextval 的发号顺序 = 提交顺序（spec §7.2）。
const syncWriteLockID = 897753

// mergeByKey 是各实体 LWW merge 的公共骨架：
//  1. 按主键查 updated_at
//  2. 不存在(ErrNoRows) → insert()
//  3. 真实错误 → 直接透传（不误判为「不存在」）
//  4. 存在但 incoming 更旧/相同 → 跳过
//  5. incoming 更新 → update()
//
// 并发插入不靠 23505 回退兜底：PostgreSQL 事务内语句报错后即 aborted 态，后续 UPDATE 必 25P02，
// 回退在真库跑不通。真正的并发防护是 sync 写事务开头的全局 advisory xact lock（串行化写事务）。
func mergeByKey(ctx context.Context, tx dbQuerier, incoming time.Time,
	keySQL string, keyArgs []any, insert, update func() error) error {
	var remote time.Time
	// FOR UPDATE：锁定已存在行，避免两个事务并发 SELECT 到旧 updated_at 后双双 UPDATE，
	// 较旧写入覆盖较新写入（破坏 LWW）。仅在同步写事务内使用，不涉及只读事务。
	err := tx.QueryRow(ctx, keySQL+" FOR UPDATE", keyArgs...).Scan(&remote)
	if errors.Is(err, pgx.ErrNoRows) {
		return insert()
	}
	if err != nil {
		return err
	}
	if !incoming.After(remote) {
		return nil
	}
	return update()
}

type SyncService struct {
	pool *pgxpool.Pool
}

func NewSyncService(pool *pgxpool.Pool) *SyncService {
	return &SyncService{pool: pool}
}

// dictEntity 是三张字典表的公共列：mergeDict 只认这些，表名与键列由 dictSpec 给出。
type dictEntity struct {
	ID        string
	Name      string
	Kind      string // 仅 labels 有
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

// dictSpec 把三张字典表的差异（表名、有没有 kind、列清单）集中在一处，
// 合并逻辑只写一遍。labels 用 (name, kind) 作合并键，其余用 (name)。
type dictSpec struct {
	table      string
	keyColumns []string // ["name"] 或 ["name","kind"]
	insertSQL  string
	updateSQL  string
}

// 服务器上的这三张表都没有同名唯一约束（spec §6.2）：去重靠合并，不靠约束，
// 撞约束会让整批同步回滚。UPDATE 推进 server_seq 让客户端拿到这次合并的结果。
var (
	ingredientSpec = dictSpec{
		table:      "ingredients",
		keyColumns: []string{"name"},
		insertSQL:  `INSERT INTO ingredients (id, name, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5)`,
		updateSQL:  `UPDATE ingredients SET name=$1, updated_at=$2, deleted_at=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
	}
	unitSpec = dictSpec{
		table:      "units",
		keyColumns: []string{"name"},
		insertSQL:  `INSERT INTO units (id, name, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5)`,
		updateSQL:  `UPDATE units SET name=$1, updated_at=$2, deleted_at=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
	}
	labelSpec = dictSpec{
		table:      "labels",
		keyColumns: []string{"name", "kind"},
		insertSQL:  `INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		updateSQL:  `UPDATE labels SET name=$1, kind=$2, updated_at=$3, deleted_at=$4, server_seq = nextval('global_server_seq') WHERE id=$5`,
	}
)

func (spec dictSpec) hasKind() bool { return slices.Contains(spec.keyColumns, "kind") }

// insertArgs / updateArgs 的参数顺序与对应 SQL 的占位符一一对应。
func (spec dictSpec) insertArgs(ent dictEntity) []any {
	args := []any{ent.ID, ent.Name}
	if spec.hasKind() {
		args = append(args, ent.Kind)
	}
	return append(args, ent.CreatedAt, ent.UpdatedAt, ent.DeletedAt)
}

func (spec dictSpec) updateArgs(ent dictEntity, id string) []any {
	args := []any{ent.Name}
	if spec.hasKind() {
		args = append(args, ent.Kind)
	}
	return append(args, ent.UpdatedAt, ent.DeletedAt, id)
}

// mergeDict 对单条字典记录做 LWW 合并，返回这条记录在服务器上的有效 id：
//  1. 按主键查 updated_at（FOR UPDATE）→ 存在则比时间，incoming 更新才 UPDATE
//  2. 主键不存在 → 按合并键查（不筛 deleted_at：软删行仍占着同名的坑，漏判会写出第二条同名数据）
//     命中同键行 Y → 把内容并进 Y、丢弃新 id X，返回 Y
//  3. 都没有 → INSERT，返回自身 id
//
// 返回的 id 与入参 id 不同时，调用方要把所有引用重写到这个 id 上（spec §7.2 第 2/3 步）。
func (s *SyncService) mergeDict(ctx context.Context, tx dbQuerier, spec dictSpec, ent dictEntity) (string, error) {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT updated_at FROM "+spec.table+" WHERE id = $1 FOR UPDATE", ent.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		conds := make([]string, len(spec.keyColumns))
		keyArgs := make([]any, len(spec.keyColumns))
		for i, col := range spec.keyColumns {
			conds[i] = fmt.Sprintf("%s = $%d", col, i+1)
			keyArgs[i] = ent.Name
			if col == "kind" {
				keyArgs[i] = ent.Kind
			}
		}
		var dupID string
		var dupUpdatedAt time.Time
		dupErr := tx.QueryRow(ctx,
			"SELECT id, updated_at FROM "+spec.table+" WHERE "+strings.Join(conds, " AND ")+" LIMIT 1 FOR UPDATE",
			keyArgs...).Scan(&dupID, &dupUpdatedAt)
		if dupErr == nil {
			if ent.UpdatedAt.After(dupUpdatedAt) {
				if _, err := tx.Exec(ctx, spec.updateSQL, spec.updateArgs(ent, dupID)...); err != nil {
					return "", err
				}
			}
			return dupID, nil // 本地更旧也返回旧 id：调用方照样把引用 remap 过去
		}
		if !errors.Is(dupErr, pgx.ErrNoRows) {
			return "", dupErr // 真实 DB 错误，透传（不当成「没有同键行」）
		}
		if _, err := tx.Exec(ctx, spec.insertSQL, spec.insertArgs(ent)...); err != nil {
			return "", err
		}
		return ent.ID, nil
	}
	if err != nil {
		return "", err
	}
	if !ent.UpdatedAt.After(remoteUpdatedAt) {
		return ent.ID, nil
	}
	if _, err := tx.Exec(ctx, spec.updateSQL, spec.updateArgs(ent, ent.ID)...); err != nil {
		return "", err
	}
	return ent.ID, nil
}
