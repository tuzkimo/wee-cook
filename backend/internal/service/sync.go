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

	"wee-cook/backend/internal/model"
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

// mergeRecipe 整条合并一条菜谱：父行 LWW + 三张子表整组替换（空数组即清空）。
// 只有作者能改，越权写入静默跳过；LWW 比较取库里的 updated_at，不用服务器 now()。
// remap 是同一批字典合并产出的「旧 id → 有效 id」：必须先重写所有引用再碰库，
// 否则引用了被合并掉的 id 会撞外键、把整次同步回滚（spec §7.2 第 3 步）。
// shortcut: 整条替换以「只有作者能改」为前提，将来允许协作编辑同一条菜谱时必须回到行级 LWW（spec §7.3）。
func (s *SyncService) mergeRecipe(ctx context.Context, tx dbQuerier, userID string, teamSet map[string]bool, remap map[string]string, r model.Recipe) error {
	remapID := func(id string) string {
		if to, ok := remap[id]; ok {
			return to
		}
		return id
	}
	r.CategoryID = remapID(r.CategoryID)
	for i := range r.LabelIDs {
		r.LabelIDs[i] = remapID(r.LabelIDs[i])
	}
	for i := range r.Ingredients {
		r.Ingredients[i].IngredientID = remapID(r.Ingredients[i].IngredientID)
		if r.Ingredients[i].UnitID != nil {
			unitID := remapID(*r.Ingredients[i].UnitID)
			r.Ingredients[i].UnitID = &unitID
		}
	}

	var remoteOwner string
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT owner_id, updated_at FROM recipes WHERE id = $1 FOR UPDATE", r.ID).
		Scan(&remoteOwner, &remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipes (id, owner_id, team_id, name, cover_path, category_id, created_at, updated_at, deleted_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			// owner_id 取当前用户：请求里带的 OwnerID 是客户端可伪造的，一律丢弃（spec §7.1）
			r.ID, userID, r.TeamID, r.Name, r.CoverPath, r.CategoryID, r.CreatedAt, r.UpdatedAt, r.DeletedAt,
		); err != nil {
			return err
		}
		return insertRecipeChildren(ctx, tx, r)
	}
	if err != nil {
		return err
	}
	if remoteOwner != userID {
		return nil
	}
	if !r.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	if r.TeamID != nil && !teamSet[*r.TeamID] {
		return nil
	}
	if _, err := tx.Exec(ctx,
		`UPDATE recipes SET team_id=$1, name=$2, cover_path=$3, category_id=$4, updated_at=$5, deleted_at=$6,
		        server_seq = nextval('global_server_seq') WHERE id=$7`,
		r.TeamID, r.Name, r.CoverPath, r.CategoryID, r.UpdatedAt, r.DeletedAt, r.ID,
	); err != nil {
		return err
	}
	if err := deleteRecipeChildren(ctx, tx, r.ID); err != nil {
		return err
	}
	return insertRecipeChildren(ctx, tx, r)
}

// 三张子表没有 server_seq、也没有 deleted_at：服务端只保存「当前有效的子行快照」，
// 所以更新时整组删掉再按 incoming 插（不删则旧子行会被回传「复活」，空子集也无法表达清空）。
func deleteRecipeChildren(ctx context.Context, tx dbQuerier, recipeID string) error {
	for _, table := range []string{"recipe_steps", "recipe_ingredients", "recipe_labels"} {
		if _, err := tx.Exec(ctx, "DELETE FROM "+table+" WHERE recipe_id = $1", recipeID); err != nil {
			return err
		}
	}
	return nil
}

func insertRecipeChildren(ctx context.Context, tx dbQuerier, r model.Recipe) error {
	for _, st := range r.Steps {
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipe_steps (id, recipe_id, sort_order, text, image_path) VALUES ($1,$2,$3,$4,$5)`,
			st.ID, r.ID, st.SortOrder, st.Text, st.ImagePath); err != nil {
			return err
		}
	}
	for _, ing := range r.Ingredients {
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, amount, unit_id, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
			ing.ID, r.ID, ing.IngredientID, ing.Amount, ing.UnitID, ing.SortOrder); err != nil {
			return err
		}
	}
	// 同一批里可能有重复 label_id（两台设备各建过同名标签、remap 到同一个 id）：
	// 主键 (recipe_id, label_id) 冲突会让整批同步回滚，先去重再插。
	seen := make(map[string]bool, len(r.LabelIDs))
	for _, labelID := range r.LabelIDs {
		if seen[labelID] {
			continue
		}
		seen[labelID] = true
		if _, err := tx.Exec(ctx,
			`INSERT INTO recipe_labels (recipe_id, label_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
			r.ID, labelID); err != nil {
			return err
		}
	}
	return nil
}
