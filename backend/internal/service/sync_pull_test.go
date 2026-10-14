package service

import (
	"context"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"wee-cook/backend/internal/model"
)

// --- Task 6：拉取（可见范围 / 游标 / 父行补齐 / 图片清单）与推送（越权团队跳过） ---
//
// pullQuerier 在 fakeQuerier 之上补三样拉取用例要用的东西：
//   - Query 按 SQL 子串返回预置行集（多 key 命中取最长者），未命中的查询返回空集（真库「没有增量」的形状）
//   - hook 优先于 rows，用于「结果由参数决定」的用例（files 只返回请求到的名字）
//   - stmts 按发出顺序记下每一条语句，用于断言 advisory lock 必须排在写事务最前
type pullQuerier struct {
	queries []queryCall
	execs   []execCall
	stmts   []string
	rows    map[string][][]any
	hook    func(sql string, args []any) ([][]any, bool)
	rowSeq  []pgx.Row
}

func (f *pullQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	f.queries = append(f.queries, queryCall{sql: sql, args: args})
	f.stmts = append(f.stmts, sql)
	if f.hook != nil {
		if rows, ok := f.hook(sql, args); ok {
			return newPullRows(rows), nil
		}
	}
	return newPullRows(f.rowsFor(sql)), nil
}

// rowsFor 取最长命中的 key 的行集；没命中就是空集（真库「没有增量」的形状）。
func (f *pullQuerier) rowsFor(sql string) [][]any {
	best := ""
	for k := range f.rows {
		if strings.Contains(sql, k) && len(k) > len(best) {
			best = k
		}
	}
	return f.rows[best]
}

func (f *pullQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	f.queries = append(f.queries, queryCall{sql: sql, args: args})
	f.stmts = append(f.stmts, sql)
	if len(f.rowSeq) > 0 {
		r := f.rowSeq[0]
		f.rowSeq = f.rowSeq[1:]
		return r
	}
	// 没排 QueryRow 队列就回落到 rows（游标这类单行查询只给一行结果）
	if rows := f.rowsFor(sql); len(rows) > 0 {
		return pullRow{vals: rows[0]}
	}
	return fakeRow{scanErr: pgx.ErrNoRows}
}

// pullRow 把一行预置值当 pgx.Row 用（fakeRow 不认 int64，而游标是 int64）。
type pullRow struct {
	vals []any
}

func (r pullRow) Scan(dest ...any) error {
	for i, d := range dest {
		if i >= len(r.vals) {
			break
		}
		assign(d, r.vals[i])
	}
	return nil
}

func (f *pullQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, execCall{sql: sql, args: args})
	f.stmts = append(f.stmts, sql)
	return pgconn.CommandTag{}, nil
}

// pullRows 是能写任意目标类型的 fake pgx.Rows：拉取用例要扫 int64（游标）、int（sort_order）、
// *float64（用量）与 **time.Time（软删时间），auth_test.go 里那个只认 string/time.Time 的 fakeRows 不够用。
type pullRows struct {
	rows [][]any
	idx  int
}

func newPullRows(rows [][]any) *pullRows { return &pullRows{rows: rows} }

func (r *pullRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }

func (r *pullRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, d := range dest {
		if i >= len(row) {
			break
		}
		assign(d, row[i])
	}
	return nil
}

func (r *pullRows) Values() ([]any, error)                       { return nil, nil }
func (r *pullRows) RawValues() [][]byte                          { return nil }
func (r *pullRows) Conn() *pgx.Conn                              { return nil }
func (r *pullRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *pullRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *pullRows) Err() error                                   { return nil }
func (r *pullRows) Close()                                       {}

// assign 把预置值写进 Scan 目标（可空列直接给值或 nil，不必自己造指针）。
// 类型对不上直接 panic：假成功会让断言骗人。
func assign(dest any, v any) {
	dv := reflect.ValueOf(dest).Elem()
	if v == nil {
		dv.Set(reflect.Zero(dv.Type()))
		return
	}
	vv := reflect.ValueOf(v)
	switch {
	case vv.Type().AssignableTo(dv.Type()):
		dv.Set(vv)
	case dv.Kind() == reflect.Ptr && vv.Type().AssignableTo(dv.Type().Elem()):
		p := reflect.New(dv.Type().Elem())
		p.Elem().Set(vv)
		dv.Set(p)
	default:
		panic(fmt.Sprintf("fake 查询值 %T 无法写入 %T", v, dest))
	}
}

// queryLike 返回第一条 SQL 含 sub 的 Query；没有则直接失败。
func queryLike(t *testing.T, q *pullQuerier, sub string) queryCall {
	t.Helper()
	for _, c := range q.queries {
		if strings.Contains(c.sql, sub) {
			return c
		}
	}
	t.Fatalf("没有 SQL 含 %q 的 Query，got %+v", sub, q.queries)
	return queryCall{}
}

// queryIndex 返回第一条 SQL 含 sub 的 Query 下标；没有则 -1（用于断言读取顺序）。
func queryIndex(q *pullQuerier, sub string) int {
	for i, c := range q.queries {
		if strings.Contains(c.sql, sub) {
			return i
		}
	}
	return -1
}

// execOf 取第一条 SQL 含 sub 的 Exec；没有则直接失败。
func execOf(t *testing.T, q *pullQuerier, sub string) execCall {
	t.Helper()
	for _, e := range q.execs {
		if strings.Contains(e.sql, sub) {
			return e
		}
	}
	t.Fatalf("没有 SQL 含 %q 的 Exec，got %+v", sub, q.execs)
	return execCall{}
}

// execAt 返回第一条 SQL 含 sub 的 Exec 下标；没有则 -1（用于断言写入顺序）。
func execAt(q *pullQuerier, sub string) int {
	for i, e := range q.execs {
		if strings.Contains(e.sql, sub) {
			return i
		}
	}
	return -1
}

// execCount 统计 SQL 含 sub 的 Exec 条数。
func execCount(q *pullQuerier, sub string) int {
	n := 0
	for _, e := range q.execs {
		if strings.Contains(e.sql, sub) {
			n++
		}
	}
	return n
}

// 可见范围必须写进 SQL：私人菜谱（team_id IS NULL）只认作者本人，团队菜谱只认我加入的团队。
// 少了 owner_id 那一半，别人的私人菜谱会被我一并拉走；少了 team_id 那一半，团队菜谱一条都拉不到。
// 两个调用者对照着断言：范围里的用户与团队集合都跟着调用者走，没有写死的值。
func TestRemoteRecipesFilteredToMyVisibleScope(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name   string
		userID string
		teams  []string
	}{
		{"我", "me", []string{"team-a"}},
		{"别人", "other", []string{"team-b"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			teamRows := make([][]any, 0, len(tc.teams))
			for _, id := range tc.teams {
				teamRows = append(teamRows, []any{id})
			}
			q := &pullQuerier{rows: map[string][][]any{"team_members": teamRows}}

			if _, err := NewSyncService(nil).getRemoteChanges(ctx, q, tc.userID, 0); err != nil {
				t.Fatalf("getRemoteChanges: %v", err)
			}

			rq := queryLike(t, q, "FROM recipes")
			for _, want := range []string{"owner_id = $2", "team_id IS NULL", "team_id = ANY($3)"} {
				if !strings.Contains(rq.sql, want) {
					t.Errorf("菜谱增量查询必须带可见范围 %q，got %s", want, rq.sql)
				}
			}
			if rq.args[1] != tc.userID {
				t.Errorf("范围里的 owner_id 必须绑当前用户 %q，got %v", tc.userID, rq.args[1])
			}
			teams, ok := rq.args[2].([]string)
			if !ok || !slices.Equal(teams, tc.teams) {
				t.Errorf("范围里的团队集合应是当前用户的团队 %v，got %v", tc.teams, rq.args[2])
			}
		})
	}
}

// 三张字典表是全局共享的：增量查询只按游标过滤，不带 owner/team 条件，也不多收参数。
func TestRemoteDictsHaveNoScopeFilter(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	q := &pullQuerier{rows: map[string][][]any{
		"team_members":                      {{"team-a"}},
		"FROM ingredients WHERE server_seq": {{"i-1", "盐", now, now, nil}},
		"FROM units WHERE server_seq":       {{"u-1", "克", now, now, nil}},
		"FROM labels WHERE server_seq":      {{"l-1", "川菜", "tag", now, now, nil}},
	}}

	payload, err := NewSyncService(nil).getRemoteChanges(ctx, q, "me", 7)
	if err != nil {
		t.Fatalf("getRemoteChanges: %v", err)
	}

	for _, table := range []string{"ingredients", "units", "labels"} {
		qq := queryLike(t, q, "FROM "+table+" WHERE server_seq")
		if strings.Contains(qq.sql, "owner_id") || strings.Contains(qq.sql, "team_id") {
			t.Errorf("%s 是全局字典，增量查询不该带归属过滤：%s", table, qq.sql)
		}
		if len(qq.args) != 1 || qq.args[0] != int64(7) {
			t.Errorf("%s 的增量查询只该带游标一个参数，got %+v", table, qq.args)
		}
	}

	if len(payload.Ingredients) != 1 || payload.Ingredients[0].ID != "i-1" {
		t.Errorf("字典增量应被读回来，got %+v", payload.Ingredients)
	}
	if len(payload.Units) != 1 || payload.Units[0].ID != "u-1" {
		t.Errorf("字典增量应被读回来，got %+v", payload.Units)
	}
	if len(payload.Labels) != 1 || payload.Labels[0].Kind != "tag" {
		t.Errorf("labels 的 kind 要一起下发，got %+v", payload.Labels)
	}
}

// 增量菜谱引用的字典行可能 server_seq 早于游标（食材三天前建的、菜谱今天改的），本次没下发；
// 不按 id 反查补齐，客户端就缺着外键行。菜谱的子行随父菜谱整条走，不需要补。
func TestBackfillAddsReferencedDictRows(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	q := &pullQuerier{rows: map[string][][]any{
		"team_members":                        {{"team-a"}},
		"FROM recipes WHERE server_seq":       {{"r-1", "me", nil, "红烧肉", nil, "cat-1", now, now, nil}},
		"FROM recipe_steps":                   {{"r-1", "s-1", 1, "切肉", nil}},
		"FROM recipe_ingredients":             {{"r-1", "ri-1", "ing-1", 200.0, "unit-1", 1}},
		"FROM recipe_labels":                  {{"r-1", "lab-1"}},
		"FROM labels WHERE server_seq":        {{"lab-1", "标签", "tag", now, now, nil}},
		"FROM labels WHERE id = ANY($1)":      {{"cat-1", "家常菜", "category", now, now, nil}},
		"FROM ingredients WHERE id = ANY($1)": {{"ing-1", "五花肉", now, now, nil}},
		"FROM units WHERE id = ANY($1)":       {{"unit-1", "克", now, now, nil}},
	}}

	payload, err := NewSyncService(nil).getRemoteChanges(ctx, q, "me", 100)
	if err != nil {
		t.Fatalf("getRemoteChanges: %v", err)
	}

	if len(payload.Recipes) != 1 {
		t.Fatalf("应读回一条菜谱，got %+v", payload.Recipes)
	}
	r := payload.Recipes[0]
	if len(r.Steps) != 1 || len(r.Ingredients) != 1 || len(r.LabelIDs) != 1 {
		t.Fatalf("子行要按 recipe_id 组装进父菜谱，got %+v", r)
	}

	// 四条引用逐个补齐；已随增量下发的 lab-1 不该被重复补拉。
	for _, tc := range []struct {
		sub  string
		want []string
	}{
		{"FROM ingredients WHERE id = ANY($1)", []string{"ing-1"}},
		{"FROM units WHERE id = ANY($1)", []string{"unit-1"}},
		{"FROM labels WHERE id = ANY($1)", []string{"cat-1"}},
	} {
		got, ok := queryLike(t, q, tc.sub).args[0].([]string)
		if !ok || !slices.Equal(got, tc.want) {
			t.Errorf("%q 应只补拉 %v（增量下发过的 id 不再问一遍），got %v", tc.sub, tc.want, got)
		}
	}

	if len(payload.Ingredients) != 1 || payload.Ingredients[0].ID != "ing-1" {
		t.Errorf("缺的食材要补齐，got %+v", payload.Ingredients)
	}
	if len(payload.Units) != 1 || payload.Units[0].ID != "unit-1" {
		t.Errorf("缺的单位要补齐，got %+v", payload.Units)
	}
	if len(payload.Labels) != 2 {
		t.Fatalf("labels 应含增量下发的 lab-1 与补拉的 cat-1，got %+v", payload.Labels)
	}
	if !slices.Contains([]string{payload.Labels[0].ID, payload.Labels[1].ID}, "cat-1") {
		t.Errorf("补拉的分类要进 payload，got %+v", payload.Labels)
	}

	// 子行随菜谱整条走：不许出现按 id 补拉子行的查询。
	for _, table := range []string{"recipe_steps", "recipe_ingredients", "recipe_labels"} {
		for _, qq := range q.queries {
			if strings.Contains(qq.sql, "FROM "+table) && !strings.Contains(qq.sql, "recipe_id = ANY") {
				t.Errorf("子行随菜谱整条走，不该按 id 补拉：%s", qq.sql)
			}
		}
	}
}

// files 只列本次返回的菜谱引用到的图片名（封面 + 步骤图，去重），且只列 files 表里确实存在的；
// 库里别人的孤儿图不能出现在我的响应里。
func TestFilesListedOnlyForReturnedRecipes(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	fileSizes := map[string]int64{"a.jpg": 100, "b.jpg": 200, "orphan.jpg": 999}

	q := &pullQuerier{
		rows: map[string][][]any{
			"team_members": {{"team-a"}},
			"FROM recipes WHERE server_seq": {
				{"r-1", "me", nil, "红烧肉", "a.jpg", "cat-1", now, now, nil},
				{"r-2", "me", nil, "糖醋排骨", "a.jpg", "cat-1", now, now, nil}, // 与 r-1 同一张封面：去重
			},
			"FROM recipe_steps": {
				{"r-1", "s-1", 1, "切肉", "b.jpg"},
				{"r-2", "s-2", 1, "下锅", nil}, // 没有步骤图
			},
		},
		// 模拟真库的 WHERE name = ANY($1)：只回请求到的名字，别的行一概不回。
		hook: func(sql string, args []any) ([][]any, bool) {
			if !strings.Contains(sql, "FROM files") {
				return nil, false
			}
			names, _ := args[0].([]string)
			out := [][]any{}
			for _, n := range names {
				if size, ok := fileSizes[n]; ok {
					out = append(out, []any{n, size})
				}
			}
			return out, true
		},
	}

	payload, err := NewSyncService(nil).getRemoteChanges(ctx, q, "me", 0)
	if err != nil {
		t.Fatalf("getRemoteChanges: %v", err)
	}

	names, ok := queryLike(t, q, "FROM files").args[0].([]string)
	if !ok || !slices.Equal(names, []string{"a.jpg", "b.jpg"}) {
		t.Fatalf("只该拿「本次菜谱引用到的图」去查 files（去重、不含孤儿图），got %v", queryLike(t, q, "FROM files").args[0])
	}
	if len(payload.Files) != 2 {
		t.Fatalf("files 清单应含两张确实存在的图，got %+v", payload.Files)
	}
	for _, f := range payload.Files {
		if f.Name == "orphan.jpg" {
			t.Errorf("没有菜谱引用的图不该下发：%+v", payload.Files)
		}
	}
	sizes := map[string]int64{}
	for _, f := range payload.Files {
		sizes[f.Name] = f.Size
	}
	if sizes["a.jpg"] != 100 || sizes["b.jpg"] != 200 {
		t.Errorf("图片清单要带 size，got %+v", payload.Files)
	}
}

// 游标是同一快照内的全局 MAX(server_seq)：四条增量通道里最大的那个，而不是某一条记录的 seq。
// 同时钉住「先读增量，再取游标」——反过来会把两次读之间提交的行永久跳过。
func TestCursorIsSnapshotMax(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	q := &pullQuerier{rows: map[string][][]any{
		"team_members":                  {{"team-a"}},
		"FROM recipes WHERE server_seq": {{"r-1", "me", nil, "红烧肉", nil, "cat-1", now, now, nil}},
		"MAX(s)":                        {{int64(431)}},
	}}

	resp, err := NewSyncService(nil).pull(ctx, q, "me", 100)
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if resp.ServerSeq != 431 {
		t.Errorf("游标应取快照内的 MAX(server_seq)，got %d", resp.ServerSeq)
	}
	if len(resp.RemoteChanges.Recipes) != 1 {
		t.Fatalf("增量要一起返回，got %+v", resp.RemoteChanges)
	}

	cq := queryLike(t, q, "MAX(s)")
	for _, table := range []string{"ingredients", "units", "labels", "recipes"} {
		if !strings.Contains(cq.sql, "MAX(server_seq)") || !strings.Contains(cq.sql, "FROM "+table) {
			t.Errorf("游标要覆盖 %s（少一条通道就会漏推进），got %s", table, cq.sql)
		}
	}
	if strings.Contains(cq.sql, "LIMIT") || strings.Contains(cq.sql, "ORDER BY") {
		t.Errorf("游标是聚合值，不该退化成「按 seq 排序取一条」：%s", cq.sql)
	}
	if ci, ri := queryIndex(q, "MAX(s)"), queryIndex(q, "FROM recipes WHERE server_seq"); ci < ri {
		t.Errorf("必须先读增量再取游标（游标查询在第 %d 条、菜谱增量在第 %d 条）", ci, ri)
	}
}

// 推来的菜谱指向我不在的团队：整条跳过，但同批其余变更照常提交（不因一条越权数据整批回滚）。
// 顺带钉住写事务的语句顺序：advisory lock 第一句 → 字典（含 remap）→ 菜谱。
func TestSyncSkipsLocalChangesForInaccessibleTeam(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	foreignTeam := "team-x"
	q := &pullQuerier{rowSeq: []pgx.Row{
		fakeRow{scanErr: pgx.ErrNoRows},                  // 食材按主键查：不存在
		fakeRow{vals: []any{"i-Y", now.Add(-time.Hour)}}, // 同名行 i-Y：合并到它
		fakeRow{scanErr: pgx.ErrNoRows},                  // 合法菜谱按主键查：不存在
	}}

	err := NewSyncService(nil).mergeLocalChanges(ctx, q, "user-1", map[string]bool{"team-y": true},
		model.SyncPayload{
			Ingredients: []model.Ingredient{{ID: "i-X", Name: "盐", CreatedAt: now, UpdatedAt: now}},
			Recipes: []model.Recipe{
				{ID: "r-bad", Name: "别人的菜", CategoryID: "cat-1", TeamID: &foreignTeam, CreatedAt: now, UpdatedAt: now},
				{ID: "r-good", Name: "我的菜", CategoryID: "cat-1", CreatedAt: now, UpdatedAt: now,
					Ingredients: []model.RecipeIngredient{{ID: "ri-1", IngredientID: "i-X", SortOrder: 1}}},
			},
		})
	if err != nil {
		t.Fatalf("mergeLocalChanges: %v", err)
	}

	if len(q.stmts) == 0 || !strings.Contains(q.stmts[0], "pg_advisory_xact_lock") {
		t.Fatalf("写事务第一条语句必须是 advisory lock，got %v", q.stmts)
	}
	if n := execCount(q, "INSERT INTO recipes"); n != 1 {
		t.Fatalf("外来 team 的菜谱要跳过、同批合法的仍要提交，期望 1 条 INSERT INTO recipes，got %d：%+v", n, q.execs)
	}
	if got := execOf(t, q, "INSERT INTO recipes").args[0]; got != "r-good" {
		t.Errorf("落库的应只有合法那条菜谱，got %v", got)
	}
	dictAt, recipeAt := execAt(q, "UPDATE ingredients"), execAt(q, "INSERT INTO recipes")
	if dictAt < 0 || recipeAt < 0 || dictAt > recipeAt {
		t.Errorf("字典必须先于菜谱合并（字典第 %d 条、菜谱第 %d 条）：%+v", dictAt, recipeAt, q.execs)
	}
	if got := execOf(t, q, "UPDATE ingredients").args[3]; got != "i-Y" {
		t.Errorf("字典应合并到旧行 i-Y，got %v", got)
	}
	// i-X 被并进 i-Y：菜谱里的引用必须在落库前重写到 i-Y。
	if got := execOf(t, q, "INSERT INTO recipe_ingredients").args[2]; got != "i-Y" {
		t.Errorf("引用要按 remap 重写成 i-Y，got %v", got)
	}
}
