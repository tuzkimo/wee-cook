package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"wee-cook/backend/internal/model"
)

// queryCall 记录一次 QueryRow 的 SQL 与参数。fakeQuerier（auth_test.go）只记 Exec，
// 而「同名合并不许筛 deleted_at」「labels 的合并键含 kind」这类断言只能看查询语句。
type queryCall struct {
	sql  string
	args []any
}

// syncQuerier 在 fakeQuerier 之上补一个 QueryRow 记录器，不动已有 fake。
type syncQuerier struct {
	*fakeQuerier
	queries []queryCall
}

func (f *syncQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	f.queries = append(f.queries, queryCall{sql: sql, args: args})
	return f.fakeQuerier.QueryRow(ctx, sql, args...)
}

func newSyncQuerier(rows ...pgx.Row) *syncQuerier {
	return &syncQuerier{fakeQuerier: &fakeQuerier{rows: rows}}
}

// execLike 取第一条 SQL 含 sub 的 Exec；没有则直接失败。
func execLike(t *testing.T, q *syncQuerier, sub string) execCall {
	t.Helper()
	for _, e := range q.execs {
		if strings.Contains(e.sql, sub) {
			return e
		}
	}
	t.Fatalf("没有 SQL 含 %q 的 Exec，got %+v", sub, q.execs)
	return execCall{}
}

// execIndex 返回第一条 SQL 含 sub 的 Exec 下标；没有则 -1（用于断言写入顺序）。
func execIndex(q *syncQuerier, sub string) int {
	for i, e := range q.execs {
		if strings.Contains(e.sql, sub) {
			return i
		}
	}
	return -1
}

// 三张表都没有同名唯一约束：插入前必须按键查过，同一批里重复推同一格也不会撞约束。
func TestMergeDictInsertsWhenAbsent(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier()

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, ingredientSpec,
		dictEntity{ID: "i-new", Name: "盐", CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "i-new" {
		t.Errorf("没有同键行时应返回自身 id，got %q", id)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "INSERT INTO ingredients") {
		t.Fatalf("恰好应写一条 INSERT INTO ingredients，got %+v", q.execs)
	}
	if got := q.execs[0].args[0]; got != "i-new" {
		t.Errorf("INSERT 的第一个参数应是自身 id，got %v", got)
	}
}

// LWW：incoming 不比 remote 新就不动库（相等也应跳过，条件用 After 而非 Before）。
func TestMergeDictSkipsOlder(t *testing.T) {
	remote := time.Now().UTC()
	for _, tc := range []struct {
		name     string
		incoming time.Time
	}{
		{"更旧", remote.Add(-time.Minute)},
		{"相同", remote},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := newSyncQuerier(fakeRow{vals: []any{remote}})

			id, err := NewSyncService(nil).mergeDict(context.Background(), q, unitSpec,
				dictEntity{ID: "u-1", Name: "克", UpdatedAt: tc.incoming})
			if err != nil {
				t.Fatalf("mergeDict: %v", err)
			}
			if id != "u-1" {
				t.Errorf("跳过时也应返回自身 id，got %q", id)
			}
			if len(q.execs) != 0 {
				t.Fatalf("incoming 不比 remote 新就不该 UPDATE，got %+v", q.execs)
			}
			if !strings.Contains(q.queries[0].sql, "FOR UPDATE") {
				t.Errorf("按主键查 updated_at 要 FOR UPDATE 锁行，got %s", q.queries[0].sql)
			}
		})
	}
}

// 主键查不到、但同名行 id=Y 存在 → 内容并进 Y、丢弃 X，返回有效 id Y（spec §7.4）。
func TestMergeDictMergesByNameIntoExistingID(t *testing.T) {
	old := time.Now().UTC().Add(-time.Hour)
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows}, // 主键 X 不存在
		fakeRow{vals: []any{"Y", old}},  // 同名行 id=Y
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, ingredientSpec,
		dictEntity{ID: "X", Name: "五花肉", UpdatedAt: old.Add(time.Minute)})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "Y" {
		t.Fatalf("同名行应合并到旧 id Y，got %q", id)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "UPDATE ingredients") {
		t.Fatalf("应恰好 UPDATE 旧行一次，got %+v", q.execs)
	}
	if got := q.execs[0].args[len(q.execs[0].args)-1]; got != "Y" {
		t.Errorf("UPDATE 应落在旧 id Y 上，got %v", got)
	}
	keyQuery := q.queries[1]
	if !strings.Contains(keyQuery.sql, "name = $1") {
		t.Errorf("按键查要用 name，got %s", keyQuery.sql)
	}
}

// 软删的同名行仍占着「同名」这个坑：漏判会写出第二条同名数据，两端从此各看各的。
// incoming 未删（DeletedAt=nil）→ 命中后 UPDATE 复活旧行，绝不 INSERT。
func TestMergeDictMatchesSoftDeletedRow(t *testing.T) {
	deleted := time.Now().UTC().Add(-time.Hour)
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows},
		fakeRow{vals: []any{"Y", deleted}}, // 该行的 deleted_at 非空（fake 只回 id/updated_at）
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, unitSpec,
		dictEntity{ID: "X", Name: "克", UpdatedAt: deleted.Add(time.Minute)})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "Y" {
		t.Fatalf("软删的同名行也要命中并返回旧 id Y，got %q", id)
	}
	if strings.Contains(q.queries[1].sql, "deleted_at") {
		t.Fatalf("按键查不得筛 deleted_at，否则会漏判软删行并插出第二条同名数据：%s", q.queries[1].sql)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "UPDATE units") {
		t.Fatalf("应 UPDATE 旧行复活，而不是 INSERT，got %+v", q.execs)
	}
	if got, ok := q.execs[0].args[2].(*time.Time); !ok || got != nil {
		t.Errorf("复活即把 deleted_at 写回 NULL，got %v", got)
	}
}

// labels 的合并键是 (name, kind)：同名不同 kind 是两种东西，合并会让菜谱的分类变成标签。
func TestMergeDictLabelKeyIncludesKind(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows}, // 主键不存在
		fakeRow{scanErr: pgx.ErrNoRows}, // 同名同 kind 的行不存在（同名但 kind 不同 → 不命中）
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, labelSpec,
		dictEntity{ID: "L1", Name: "川菜", Kind: "tag", UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "L1" {
		t.Fatalf("kind 不同不该合并，应返回自身 id，got %q", id)
	}
	keyQuery := q.queries[1]
	if !strings.Contains(keyQuery.sql, "name = $1 AND kind = $2") {
		t.Fatalf("labels 的合并键要含 kind，got %s", keyQuery.sql)
	}
	if len(keyQuery.args) != 2 || keyQuery.args[1] != "tag" {
		t.Fatalf("按键查要带上 kind 参数，got %+v", keyQuery.args)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "INSERT INTO labels") {
		t.Fatalf("应 INSERT 自身这条，got %+v", q.execs)
	}
	if got := q.execs[0].args[2]; got != "tag" {
		t.Errorf("INSERT 要落 kind 列，got %v", got)
	}
}

// --- Task 5：菜谱整条合并 + 作者归属校验 ---

// OwnerID 是客户端可伪造的：落库归属一律取当前登录用户（spec §7.1）。
func TestMergeRecipeInsertsWithUploaderAsOwner(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier(fakeRow{scanErr: pgx.ErrNoRows})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil, nil,
		model.Recipe{ID: "r-1", OwnerID: "attacker", Name: "红烧肉", CategoryID: "c-1",
			CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeRecipe: %v", err)
	}
	if got := execLike(t, q, "INSERT INTO recipes").args[1]; got != "user-1" {
		t.Errorf("owner_id 必须取当前用户，got %v", got)
	}
	for _, e := range q.execs {
		for _, a := range e.args {
			if a == "attacker" {
				t.Fatalf("请求里伪造的 OwnerID 不得落库：%+v", e)
			}
		}
	}
}

// 库里那行是别人的 → 越权写入静默跳过，不报错也不产生任何写入。
func TestMergeRecipeSkipsWhenNotOwner(t *testing.T) {
	remote := time.Now().UTC()
	q := newSyncQuerier(fakeRow{vals: []any{"owner-other", remote}})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil, nil,
		model.Recipe{ID: "r-1", Name: "别人的菜", CategoryID: "c-1", UpdatedAt: remote.Add(time.Hour)})
	if err != nil {
		t.Fatalf("越权跳过不该报错：%v", err)
	}
	if len(q.execs) != 0 {
		t.Fatalf("不是作者就不该产生任何写入，got %+v", q.execs)
	}
}

// LWW 比较的是库里的 updated_at，不是服务器 now()：remote 故意取未来时间，
// 若实现拿 now() 比较，incoming（未来）会被误判为「更新」而写库，这条即红。
func TestMergeRecipeSkipsOlder(t *testing.T) {
	remote := time.Now().UTC().Add(time.Hour)
	for _, tc := range []struct {
		name     string
		incoming time.Time
	}{
		{"更旧", remote.Add(-time.Minute)},
		{"相同", remote},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := newSyncQuerier(fakeRow{vals: []any{"user-1", remote}})

			err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil, nil,
				model.Recipe{ID: "r-1", Name: "红烧肉", CategoryID: "c-1", UpdatedAt: tc.incoming})
			if err != nil {
				t.Fatalf("mergeRecipe: %v", err)
			}
			if len(q.execs) != 0 {
				t.Fatalf("incoming 不比 remote 新就不该写库，got %+v", q.execs)
			}
			if !strings.Contains(q.queries[0].sql, "FOR UPDATE") {
				t.Errorf("查父行要 FOR UPDATE 锁行，got %s", q.queries[0].sql)
			}
		})
	}
}

// 推到不是自己成员的团队：整条跳过，不落库。
func TestMergeRecipeSkipsForeignTeam(t *testing.T) {
	remote := time.Now().UTC()
	team := "team-x"
	q := newSyncQuerier(fakeRow{vals: []any{"user-1", remote}})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1",
		map[string]bool{"team-y": true}, nil,
		model.Recipe{ID: "r-1", Name: "红烧肉", CategoryID: "c-1", TeamID: &team,
			UpdatedAt: remote.Add(time.Minute)})
	if err != nil {
		t.Fatalf("不属于该团队时跳过，不该报错：%v", err)
	}
	if len(q.execs) != 0 {
		t.Fatalf("team_id 不在 teamSet 里就不该产生任何写入，got %+v", q.execs)
	}
}

// 新建菜谱也不能往别人团队里塞：库里没有该 id 且 team_id 不属于当前用户时整条跳过，
// 父行与三张子行都不许 INSERT，也不报错（spec §5 硬规则 1，校验先于任何写库动作）。
func TestMergeRecipeSkipsForeignTeamOnInsert(t *testing.T) {
	now := time.Now().UTC()
	team := "team-x"
	q := newSyncQuerier(fakeRow{scanErr: pgx.ErrNoRows})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1",
		map[string]bool{"team-y": true}, nil,
		model.Recipe{ID: "r-1", Name: "红烧肉", CategoryID: "c-1", TeamID: &team,
			CreatedAt: now, UpdatedAt: now,
			Steps:       []model.RecipeStep{{ID: "s-1", SortOrder: 1, Text: "切肉"}},
			Ingredients: []model.RecipeIngredient{{ID: "ri-1", IngredientID: "i-1", SortOrder: 1}},
			LabelIDs:    []string{"l-1"}})
	if err != nil {
		t.Fatalf("不属于该团队时跳过，不该报错：%v", err)
	}
	if len(q.execs) != 0 {
		t.Fatalf("新建菜谱的 team_id 不在 teamSet 里就不该产生任何写入（父行与子行都不许 INSERT），got %+v", q.execs)
	}
}

// 更新命中时三张子表整组替换：UPDATE 父行 → DELETE 全部子行 → 按 incoming 重插。
func TestMergeRecipeReplacesChildrenWholesale(t *testing.T) {
	remote := time.Now().UTC()
	q := newSyncQuerier(fakeRow{vals: []any{"user-1", remote}})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil, nil, model.Recipe{
		ID: "r-1", Name: "红烧肉", CategoryID: "c-1", UpdatedAt: remote.Add(time.Minute),
		Steps:       []model.RecipeStep{{ID: "s-1", SortOrder: 1, Text: "切肉"}},
		Ingredients: []model.RecipeIngredient{{ID: "ri-1", IngredientID: "i-1", SortOrder: 1}},
		LabelIDs:    []string{"l-1"},
	})
	if err != nil {
		t.Fatalf("mergeRecipe: %v", err)
	}

	updateAt := execIndex(q, "UPDATE recipes")
	if updateAt < 0 {
		t.Fatalf("命中更新要 UPDATE 父行，got %+v", q.execs)
	}
	for _, pair := range [][2]string{
		{"DELETE FROM recipe_steps", "INSERT INTO recipe_steps"},
		{"DELETE FROM recipe_ingredients", "INSERT INTO recipe_ingredients"},
		{"DELETE FROM recipe_labels", "INSERT INTO recipe_labels"},
	} {
		delAt, insAt := execIndex(q, pair[0]), execIndex(q, pair[1])
		if delAt < 0 || insAt < 0 {
			t.Fatalf("更新命中要整组替换子行，缺 %s / %s：%+v", pair[0], pair[1], q.execs)
		}
		if delAt < updateAt {
			t.Errorf("%s 应在 UPDATE 父行之后", pair[0])
		}
		if insAt < delAt {
			t.Errorf("%s 应在 %s 之后", pair[1], pair[0])
		}
		if got := q.execs[delAt].args[0]; got != "r-1" {
			t.Errorf("%s 的 recipe_id 应是 r-1，got %v", pair[0], got)
		}
	}
}

// 同一批里被合并掉的 ingredient_id / unit_id 必须先按 remap 重写，否则整批同步回滚。
func TestMergeRecipeRemapsIngredientReference(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier(fakeRow{scanErr: pgx.ErrNoRows})
	unit := "u-X"

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil,
		map[string]string{"ing-X": "ing-Y", "u-X": "u-Y"},
		model.Recipe{ID: "r-1", Name: "红烧肉", CategoryID: "c-1", CreatedAt: now, UpdatedAt: now,
			Ingredients: []model.RecipeIngredient{{ID: "ri-1", IngredientID: "ing-X", UnitID: &unit, SortOrder: 1}}})
	if err != nil {
		t.Fatalf("mergeRecipe: %v", err)
	}

	// INSERT 参数顺序：id, recipe_id, ingredient_id, amount, unit_id, sort_order
	insert := execLike(t, q, "INSERT INTO recipe_ingredients")
	if got := insert.args[2]; got != "ing-Y" {
		t.Errorf("ingredient_id 应重写为 ing-Y，got %v", got)
	}
	if got, ok := insert.args[4].(*string); !ok || got == nil || *got != "u-Y" {
		t.Errorf("unit_id 应重写为 u-Y，got %v", insert.args[4])
	}
}

// remap 里的 label id 也要作用到 category_id 与 label_ids，且同一批重复的 label_id 要去重。
func TestMergeRecipeRemapsCategoryAndLabels(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier(fakeRow{scanErr: pgx.ErrNoRows})

	err := NewSyncService(nil).mergeRecipe(context.Background(), q, "user-1", nil,
		map[string]string{"X": "Y"},
		model.Recipe{ID: "r-1", Name: "红烧肉", CategoryID: "X", CreatedAt: now, UpdatedAt: now,
			LabelIDs: []string{"X", "X"}})
	if err != nil {
		t.Fatalf("mergeRecipe: %v", err)
	}

	// INSERT 参数顺序：id, owner_id, team_id, name, cover_path, category_id, ...
	if got := execLike(t, q, "INSERT INTO recipes").args[5]; got != "Y" {
		t.Errorf("category_id 应重写为 Y，got %v", got)
	}
	labelInserts := 0
	for _, e := range q.execs {
		if strings.Contains(e.sql, "INSERT INTO recipe_labels") {
			labelInserts++
			if got := e.args[1]; got != "Y" {
				t.Errorf("label_id 应重写为 Y，got %v", got)
			}
		}
	}
	if labelInserts != 1 {
		t.Errorf("重复的 label_id 要去重成一条，got %d：%+v", labelInserts, q.execs)
	}
}
