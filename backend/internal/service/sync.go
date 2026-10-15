package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
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

// advisoryLockSQL 由 syncWriteLockID 生成，免得锁编号在代码里出现两份。
var advisoryLockSQL = fmt.Sprintf("SELECT pg_advisory_xact_lock(%d)", syncWriteLockID)

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
// 否则引用会指向服务器上不存在的行（当前 schema 下 category_id / ingredient_id / unit_id 都没建外键，
// 不会立刻报错，但引用悬空；补上外键后就是 23503，会把整次同步回滚）（spec §7.2 第 3 步）。
// LWW 骨架不复用通用辅助：父行必须在同一次 FOR UPDATE 里同时拿到 owner_id 与 updated_at，
// 而通用辅助只扫单值 updated_at。
// shortcut: 整条替换以「只有作者能改」为前提，将来允许协作编辑同一条菜谱时必须回到行级 LWW（spec §7.3）。
func (s *SyncService) mergeRecipe(ctx context.Context, tx dbQuerier, userID string, remap map[string]string, r model.Recipe) error {
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
			`INSERT INTO recipes (id, owner_id, is_public, name, cover_path, category_id, created_at, updated_at, deleted_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			// owner_id 取当前用户：请求里带的 OwnerID 是客户端可伪造的，一律丢弃（spec §7.1）。
			// is_public 取请求里的值：菜谱的主人就是当前用户，公开与否是他的选择。
			r.ID, userID, r.IsPublic, r.Name, r.CoverPath, r.CategoryID, r.CreatedAt, r.UpdatedAt, r.DeletedAt,
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
	if _, err := tx.Exec(ctx,
		`UPDATE recipes SET is_public=$1, name=$2, cover_path=$3, category_id=$4, updated_at=$5, deleted_at=$6,
		        server_seq = nextval('global_server_seq') WHERE id=$7`,
		r.IsPublic, r.Name, r.CoverPath, r.CategoryID, r.UpdatedAt, r.DeletedAt, r.ID,
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

// --- 同步主流程（Task 6）：推送与拉取 ---

// Sync 一次完整同步：先把客户端推来的改动合进库（写事务），再在同一个只读快照里读增量与推进游标。
func (s *SyncService) Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error) {
	if err := s.applyLocalChanges(ctx, userID, req.LocalChanges); err != nil {
		return nil, fmt.Errorf("applyLocalChanges: %w", err)
	}

	// 读增量与取游标必须在同一个 REPEATABLE READ 快照里，且先读后推进（spec §7.5）。
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin read tx: %w", err)
	}
	defer tx.Rollback(ctx)

	resp, err := s.pull(ctx, tx, userID, req.LastServerSeq)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit read tx: %w", err)
	}
	return resp, nil
}

// maxServerSeqSQL 覆盖全部四条增量通道：游标是它们的最大 server_seq，空库上取 0（而不是 NULL）。
const maxServerSeqSQL = `SELECT COALESCE(MAX(s), 0) FROM (
	SELECT MAX(server_seq) AS s FROM ingredients
	UNION ALL SELECT MAX(server_seq) FROM units
	UNION ALL SELECT MAX(server_seq) FROM labels
	UNION ALL SELECT MAX(server_seq) FROM recipes
) m`

// pull 在同一个只读事务里读完增量再取游标：游标取全库的 MAX(server_seq)，
// 而不是任何一条记录的 seq；反过来（先取游标再读增量）会把两次读之间提交的行永久跳过。
//
// 护栏：服务器库被重建或恢复旧备份后，MAX(server_seq) 会低于客户端游标，此时只按
// `server_seq > sinceSeq` 增量读会永远返回 0 条（两端各看各的且不报错）。所以拿同一快照的 MAX
// 与客户端游标比，检测到世代回退就按 sinceSeq=0 重读一次全量（LWW 幂等，重复应用无副作用），
// 并让返回的游标退回当前世代的最大值。不引入第二套游标。
func (s *SyncService) pull(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) (*model.SyncResponse, error) {
	remote, err := s.getRemoteChanges(ctx, q, userID, sinceSeq)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}
	cursor, err := maxServerSeq(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("read cursor: %w", err)
	}
	if sinceSeq > cursor {
		log.Printf("同步：检测到服务器世代回退（客户端游标 %d > 快照 MAX(server_seq) %d），按 sinceSeq=0 重读全量", sinceSeq, cursor)
		if remote, err = s.getRemoteChanges(ctx, q, userID, 0); err != nil {
			return nil, fmt.Errorf("getRemoteChanges (generation rollback): %w", err)
		}
	}
	// 收藏集合只在这之后取一次：正常增量与回退重读两条路径都带得上同一份收藏集合。
	// 它与增量走同一个只读快照。
	favoriteIDs, err := s.favoriteRecipeIDs(ctx, q, userID)
	if err != nil {
		return nil, fmt.Errorf("read favorite recipe ids: %w", err)
	}
	return &model.SyncResponse{ServerSeq: cursor, RemoteChanges: remote, FavoriteRecipeIDs: favoriteIDs}, nil
}

func maxServerSeq(ctx context.Context, q dbQuerier) (int64, error) {
	var cursor int64
	if err := q.QueryRow(ctx, maxServerSeqSQL).Scan(&cursor); err != nil {
		return 0, err
	}
	return cursor, nil
}

// favoriteRecipeIDs 是「我当前有效的收藏」：JOIN recipes 筛掉作者已取消公开或已软删的（spec §7.3）。
// 返回空切片而不是 nil：客户端拿它整表替换本地收藏，JSON 里的 [] 与 null 含义不同（是「一条都不剩了」）。
func (s *SyncService) favoriteRecipeIDs(ctx context.Context, q dbQuerier, userID string) ([]string, error) {
	return queryList(ctx, q,
		`SELECT f.recipe_id FROM favorites f JOIN recipes r ON r.id = f.recipe_id
		 WHERE f.user_id = $1 AND r.is_public = 1 AND r.deleted_at IS NULL`,
		[]any{userID}, func(rows pgx.Rows) (string, error) {
			var id string
			err := rows.Scan(&id)
			return id, err
		})
}

// applyLocalChanges 在一个写事务里落地客户端改动（spec §7.2）。
func (s *SyncService) applyLocalChanges(ctx context.Context, userID string, req model.SyncPayload) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin write tx: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := s.mergeLocalChanges(ctx, tx, userID, req); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// mergeLocalChanges 是写事务体（抽出来以便注入 fake 断言语句顺序）：
// ① advisory lock → ② 合并字典并收集 remap → ③ 合并菜谱（mergeRecipe 内部先按 remap 重写引用）。
// 顺序不能换：同批菜谱可能引用被合并掉的字典 id，先合并菜谱就会写出悬空引用。
func (s *SyncService) mergeLocalChanges(ctx context.Context, tx dbQuerier, userID string, req model.SyncPayload) error {
	// 全局串行化所有同步写事务：nextval 按调用序发号，并发交错提交会出现「低 seq 晚提交」被已推进的游标跳过。
	if _, err := tx.Exec(ctx, advisoryLockSQL); err != nil {
		return err
	}

	remap := make(map[string]string)
	for _, it := range req.Ingredients {
		ent := dictEntity{ID: it.ID, Name: it.Name, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, DeletedAt: it.DeletedAt}
		if err := s.mergeOneDict(ctx, tx, ingredientSpec, ent, remap); err != nil {
			return err
		}
	}
	for _, it := range req.Units {
		ent := dictEntity{ID: it.ID, Name: it.Name, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, DeletedAt: it.DeletedAt}
		if err := s.mergeOneDict(ctx, tx, unitSpec, ent, remap); err != nil {
			return err
		}
	}
	for _, it := range req.Labels {
		ent := dictEntity{ID: it.ID, Name: it.Name, Kind: it.Kind, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, DeletedAt: it.DeletedAt}
		if err := s.mergeOneDict(ctx, tx, labelSpec, ent, remap); err != nil {
			return err
		}
	}

	for _, r := range req.Recipes {
		if err := s.mergeRecipe(ctx, tx, userID, remap, r); err != nil {
			return fmt.Errorf("merge recipe %s: %w", r.ID, err)
		}
	}
	return nil
}

// mergeOneDict 合并一条字典记录，并把「旧 id → 有效 id」记进 remap 供菜谱重写引用。
func (s *SyncService) mergeOneDict(ctx context.Context, tx dbQuerier, spec dictSpec, ent dictEntity, remap map[string]string) error {
	effectiveID, err := s.mergeDict(ctx, tx, spec, ent)
	if err != nil {
		return fmt.Errorf("merge %s %s: %w", spec.table, ent.ID, err)
	}
	if effectiveID != ent.ID {
		remap[ent.ID] = effectiveID
	}
	return nil
}

// getRemoteChanges 读本次增量：字典全局共享、无过滤；菜谱按可见范围过滤；再补齐引用、列图片清单。
func (s *SyncService) getRemoteChanges(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) (model.SyncPayload, error) {
	// 五个集合一律给空切片而不是 nil：客户端拿到响应直接遍历，首轮同步（服务端还没数据）的 null 会炸。
	payload := model.SyncPayload{
		Ingredients: []model.Ingredient{},
		Units:       []model.Unit{},
		Labels:      []model.Label{},
		Recipes:     []model.Recipe{},
		Files:       []model.FileRef{},
	}

	var err error
	if payload.Ingredients, err = queryIngredients(ctx, q, sinceSeq); err != nil {
		return payload, fmt.Errorf("query ingredients: %w", err)
	}
	if payload.Units, err = queryUnits(ctx, q, sinceSeq); err != nil {
		return payload, fmt.Errorf("query units: %w", err)
	}
	if payload.Labels, err = queryLabels(ctx, q, sinceSeq); err != nil {
		return payload, fmt.Errorf("query labels: %w", err)
	}
	if payload.Recipes, err = queryRecipes(ctx, q, userID, sinceSeq); err != nil {
		return payload, fmt.Errorf("query recipes: %w", err)
	}

	// 增量菜谱引用的字典行可能 server_seq 早于游标、本次没下发 → 按 id 反查补齐（spec §7.5）。
	if err := backfillReferenced(ctx, q, &payload); err != nil {
		return payload, fmt.Errorf("backfill referenced: %w", err)
	}

	// 图片清单只列本次菜谱引用到的、files 表里确实存在的文件名，客户端对本地没有的逐个下载。
	if payload.Files, err = queryFiles(ctx, q, payload.Recipes); err != nil {
		return payload, fmt.Errorf("query files: %w", err)
	}
	return payload, nil
}

// recipesVisibleScope 是菜谱增量的可见范围，写进 SQL 而不是发完再筛：我的 ∪ 我收藏的（spec §7.3）。$2 = 我。
// 收藏分支必须同筛 is_public 与 deleted_at：收藏行在作者取消公开后仍保留，不筛就会继续下发私有正文（隐私泄漏）。
// 外层 `r.id` 必须带前缀：queryRecipes 的 LEFT JOIN users 也有一列 id，裸写 id 会 42702（owner_id 两表都无，可裸写）。
const recipesVisibleScope = "(owner_id = $2) OR r.id IN (SELECT f.recipe_id FROM favorites f JOIN recipes r2 ON r2.id = f.recipe_id WHERE f.user_id = $2 AND r2.is_public = 1 AND r2.deleted_at IS NULL)"

// recipeSelectColumns 是菜谱行的列清单（含作者昵称）：增量与社区详情都用它，
// 两处返回的菜谱形状才会一致（客户端可以拿同一份落库逻辑处理）。
const recipeSelectColumns = `r.id, r.owner_id, r.is_public, r.name, r.cover_path, r.category_id, r.created_at, r.updated_at, r.deleted_at, u.nickname`

// scanRecipeRow 从 recipeSelectColumns 的一行扫出菜谱。
// 子集合给空切片：JSON 里的空数组才表达得出「清空」（model.Recipe 的契约）。
func scanRecipeRow(rows pgx.Rows) (model.Recipe, error) {
	var r model.Recipe
	err := rows.Scan(&r.ID, &r.OwnerID, &r.IsPublic, &r.Name, &r.CoverPath, &r.CategoryID,
		&r.CreatedAt, &r.UpdatedAt, &r.DeletedAt, &r.OwnerNickname)
	r.Steps, r.Ingredients, r.LabelIDs = []model.RecipeStep{}, []model.RecipeIngredient{}, []string{}
	return r, err
}

func queryRecipes(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) ([]model.Recipe, error) {
	// 菜谱行必须先读完并关掉再查子表：读阶段整个跑在同一个只读事务里，共享一条连接。
	// LEFT JOIN users 只为取作者昵称，不改变行数（users.id 是主键）。
	recipes, err := queryList(ctx, q,
		`SELECT `+recipeSelectColumns+`
		 FROM recipes r LEFT JOIN users u ON u.id = r.owner_id
		 WHERE r.server_seq > $1 AND (`+recipesVisibleScope+`)`,
		[]any{sinceSeq, userID}, scanRecipeRow)
	if err != nil {
		return nil, err
	}
	if len(recipes) == 0 {
		return recipes, nil
	}
	return attachRecipeChildren(ctx, q, recipes)
}

// recipeStepRow 等三个中间类型把子行与它的父菜谱 id 凑在一起，便于按父 id 分组。
type recipeStepRow struct {
	recipeID string
	step     model.RecipeStep
}

type recipeIngredientRow struct {
	recipeID   string
	ingredient model.RecipeIngredient
}

type recipeLabelRow struct {
	recipeID string
	labelID  string
}

// attachRecipeChildren 三张子表各一条查询按 recipe_id 取回，在 Go 里组装进父菜谱。
// 不用 wee-count 那种 array_agg：这里列多，读回来分组比在 SQL 里拼数组直白。
func attachRecipeChildren(ctx context.Context, q dbQuerier, recipes []model.Recipe) ([]model.Recipe, error) {
	byID := make(map[string]*model.Recipe, len(recipes))
	ids := make([]string, 0, len(recipes))
	for i := range recipes {
		byID[recipes[i].ID] = &recipes[i]
		ids = append(ids, recipes[i].ID)
	}

	steps, err := queryList(ctx, q,
		`SELECT recipe_id, id, sort_order, text, image_path FROM recipe_steps
		 WHERE recipe_id = ANY($1) ORDER BY recipe_id, sort_order`,
		[]any{ids}, func(rows pgx.Rows) (recipeStepRow, error) {
			var it recipeStepRow
			err := rows.Scan(&it.recipeID, &it.step.ID, &it.step.SortOrder, &it.step.Text, &it.step.ImagePath)
			return it, err
		})
	if err != nil {
		return nil, err
	}
	for _, it := range steps {
		if r := byID[it.recipeID]; r != nil {
			r.Steps = append(r.Steps, it.step)
		}
	}

	ings, err := queryList(ctx, q,
		`SELECT recipe_id, id, ingredient_id, amount, unit_id, sort_order FROM recipe_ingredients
		 WHERE recipe_id = ANY($1) ORDER BY recipe_id, sort_order`,
		[]any{ids}, func(rows pgx.Rows) (recipeIngredientRow, error) {
			var it recipeIngredientRow
			err := rows.Scan(&it.recipeID, &it.ingredient.ID, &it.ingredient.IngredientID,
				&it.ingredient.Amount, &it.ingredient.UnitID, &it.ingredient.SortOrder)
			return it, err
		})
	if err != nil {
		return nil, err
	}
	for _, it := range ings {
		if r := byID[it.recipeID]; r != nil {
			r.Ingredients = append(r.Ingredients, it.ingredient)
		}
	}

	labels, err := queryList(ctx, q,
		`SELECT recipe_id, label_id FROM recipe_labels WHERE recipe_id = ANY($1) ORDER BY recipe_id, label_id`,
		[]any{ids}, func(rows pgx.Rows) (recipeLabelRow, error) {
			var it recipeLabelRow
			err := rows.Scan(&it.recipeID, &it.labelID)
			return it, err
		})
	if err != nil {
		return nil, err
	}
	for _, it := range labels {
		if r := byID[it.recipeID]; r != nil {
			r.LabelIDs = append(r.LabelIDs, it.labelID)
		}
	}

	return recipes, nil
}

// backfillReferenced 补齐「增量菜谱引用到、但本次没下发的字典行」：字典行的 server_seq 可能早于
// 游标（食材是三天前建的、菜谱是今天改的），不补客户端就缺外键行。菜谱子行随父菜谱整条走，不用补。
// category_id 与 label_ids 都指向 labels（spec §7.4）。
func backfillReferenced(ctx context.Context, q dbQuerier, payload *model.SyncPayload) error {
	refIngredients, refUnits, refLabels := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, r := range payload.Recipes {
		refLabels[r.CategoryID] = true
		for _, labelID := range r.LabelIDs {
			refLabels[labelID] = true
		}
		for _, ing := range r.Ingredients {
			refIngredients[ing.IngredientID] = true
			if ing.UnitID != nil {
				refUnits[*ing.UnitID] = true
			}
		}
	}

	if ids := pendingIDs(refIngredients, payload.Ingredients, func(it model.Ingredient) string { return it.ID }); len(ids) > 0 {
		extra, err := queryIngredientsByIDs(ctx, q, ids)
		if err != nil {
			return err
		}
		payload.Ingredients = append(payload.Ingredients, extra...)
	}
	if ids := pendingIDs(refUnits, payload.Units, func(it model.Unit) string { return it.ID }); len(ids) > 0 {
		extra, err := queryUnitsByIDs(ctx, q, ids)
		if err != nil {
			return err
		}
		payload.Units = append(payload.Units, extra...)
	}
	if ids := pendingIDs(refLabels, payload.Labels, func(it model.Label) string { return it.ID }); len(ids) > 0 {
		extra, err := queryLabelsByIDs(ctx, q, ids)
		if err != nil {
			return err
		}
		payload.Labels = append(payload.Labels, extra...)
	}
	return nil
}

// pendingIDs 返回 refs 里「还没随增量下发过」的 id（下发过的不重复补拉），排序后返回。
// 空 id 直接丢掉：菜谱里悬空的引用没必要拿去查库。
func pendingIDs[T any](refs map[string]bool, items []T, id func(T) string) []string {
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		seen[id(it)] = true
	}
	pending := []string{}
	for k := range refs {
		if k != "" && !seen[k] {
			pending = append(pending, k)
		}
	}
	slices.Sort(pending)
	return pending
}

// queryList 是「一条 SELECT 扫成切片」的公共骨架：四张简单表（三字典 + files）与菜谱三张子表共用。
func queryList[T any](ctx context.Context, q dbQuerier, sql string, args []any, scan func(pgx.Rows) (T, error)) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []T{}
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

const dictColumns = `id, name, created_at, updated_at, deleted_at`
const labelColumns = `id, name, kind, created_at, updated_at, deleted_at`

func queryIngredients(ctx context.Context, q dbQuerier, sinceSeq int64) ([]model.Ingredient, error) {
	return queryList(ctx, q, "SELECT "+dictColumns+" FROM ingredients WHERE server_seq > $1",
		[]any{sinceSeq}, scanIngredient)
}

func queryIngredientsByIDs(ctx context.Context, q dbQuerier, ids []string) ([]model.Ingredient, error) {
	return queryList(ctx, q, "SELECT "+dictColumns+" FROM ingredients WHERE id = ANY($1)",
		[]any{ids}, scanIngredient)
}

func queryUnits(ctx context.Context, q dbQuerier, sinceSeq int64) ([]model.Unit, error) {
	return queryList(ctx, q, "SELECT "+dictColumns+" FROM units WHERE server_seq > $1",
		[]any{sinceSeq}, scanUnit)
}

func queryUnitsByIDs(ctx context.Context, q dbQuerier, ids []string) ([]model.Unit, error) {
	return queryList(ctx, q, "SELECT "+dictColumns+" FROM units WHERE id = ANY($1)",
		[]any{ids}, scanUnit)
}

func queryLabels(ctx context.Context, q dbQuerier, sinceSeq int64) ([]model.Label, error) {
	return queryList(ctx, q, "SELECT "+labelColumns+" FROM labels WHERE server_seq > $1",
		[]any{sinceSeq}, scanLabel)
}

func queryLabelsByIDs(ctx context.Context, q dbQuerier, ids []string) ([]model.Label, error) {
	return queryList(ctx, q, "SELECT "+labelColumns+" FROM labels WHERE id = ANY($1)",
		[]any{ids}, scanLabel)
}

func scanIngredient(rows pgx.Rows) (model.Ingredient, error) {
	var it model.Ingredient
	err := rows.Scan(&it.ID, &it.Name, &it.CreatedAt, &it.UpdatedAt, &it.DeletedAt)
	return it, err
}

func scanUnit(rows pgx.Rows) (model.Unit, error) {
	var it model.Unit
	err := rows.Scan(&it.ID, &it.Name, &it.CreatedAt, &it.UpdatedAt, &it.DeletedAt)
	return it, err
}

func scanLabel(rows pgx.Rows) (model.Label, error) {
	var it model.Label
	err := rows.Scan(&it.ID, &it.Name, &it.Kind, &it.CreatedAt, &it.UpdatedAt, &it.DeletedAt)
	return it, err
}

// queryFiles 只按本次返回的菜谱引用到的图片名去查：files 没有归属列，谁引用了它谁才读得到（spec §8.1）。
func queryFiles(ctx context.Context, q dbQuerier, recipes []model.Recipe) ([]model.FileRef, error) {
	names := referencedFileNames(recipes)
	if len(names) == 0 {
		return []model.FileRef{}, nil
	}
	return queryList(ctx, q, "SELECT name, size FROM files WHERE name = ANY($1)",
		[]any{names}, func(rows pgx.Rows) (model.FileRef, error) {
			var f model.FileRef
			err := rows.Scan(&f.Name, &f.Size)
			return f, err
		})
}

// referencedFileNames 收齐菜谱里的图片名（封面 + 步骤图），去重并排序（参数顺序稳定）。
func referencedFileNames(recipes []model.Recipe) []string {
	names := make(map[string]bool)
	for _, r := range recipes {
		if r.CoverPath != nil {
			names[*r.CoverPath] = true
		}
		for _, st := range r.Steps {
			if st.ImagePath != nil {
				names[*st.ImagePath] = true
			}
		}
	}
	return slices.Sorted(maps.Keys(names))
}
