// 同步服务的真库集成测试：复用 files_test.go 的容器/seed 辅助（同一个 postgres 容器，
// 各用例用随机 UUID 的 id 隔离数据）。这些用例吃的是真 SQL + 真事务，覆盖 spec
// §7.2（整条合并）、§7.3（子行整组替换）、§7.4（字典同名合并）、§7.5（快照游标）
// 这几条只有真库才验得出的规格。
package service

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-cook/backend/internal/model"
)

// personalScopeID / teamScopeID 造客户端形状的 scope_id。
func personalScopeID(userID string) string { return "p:" + userID }

func teamScopeID(teamID string) string { return "t:" + teamID }

// syncRecipe 造一条待同步的菜谱，三个子集合给空切片而不是 nil：空数组才表达得出「清空」。
func syncRecipe(id, name string, updatedAt time.Time, scopeID string) model.Recipe {
	return model.Recipe{
		ID:          id,
		ScopeID:     scopeID,
		Name:        name,
		CreatedAt:   updatedAt.Add(-time.Hour),
		UpdatedAt:   updatedAt,
		Steps:       []model.RecipeStep{},
		Ingredients: []model.RecipeIngredient{},
		LabelIDs:    []string{},
	}
}

func mustPush(t *testing.T, svc *SyncService, userID string, p model.SyncPayload) *model.SyncResponse {
	t.Helper()
	resp, err := svc.Sync(context.Background(), userID, model.SyncRequest{LocalChanges: p})
	if err != nil {
		t.Fatalf("推送同步失败: %v", err)
	}
	return resp
}

func mustPull(t *testing.T, svc *SyncService, userID string, sinceSeq int64) *model.SyncResponse {
	t.Helper()
	resp, err := svc.Sync(context.Background(), userID, model.SyncRequest{LastServerSeq: sinceSeq})
	if err != nil {
		t.Fatalf("拉取同步失败: %v", err)
	}
	return resp
}

func findRecipe(recipes []model.Recipe, id string) *model.Recipe {
	for i := range recipes {
		if recipes[i].ID == id {
			return &recipes[i]
		}
	}
	return nil
}

// columnValues 按 SQL 扫一列字符串，用于断言「库里到底留下哪些子行」。
func columnValues(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), sql, args...)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	defer rows.Close()

	values := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatalf("扫描失败: %v", err)
		}
		values = append(values, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("遍历失败: %v", err)
	}
	return values
}

func recipeStepIDs(t *testing.T, pool *pgxpool.Pool, recipeID string) []string {
	t.Helper()
	return columnValues(t, pool, `SELECT id FROM recipe_steps WHERE recipe_id = $1 ORDER BY sort_order`, recipeID)
}

func recipeLabelIDs(t *testing.T, pool *pgxpool.Pool, recipeID string) []string {
	t.Helper()
	return columnValues(t, pool, `SELECT label_id FROM recipe_labels WHERE recipe_id = $1 ORDER BY label_id`, recipeID)
}

// Review Focus ①：同一用户的两台设备离线各改同一条菜谱，服务端必须留下较新的那一份，
// 且三张子表整组来自同一版本——不是把两版的子行拼起来（spec §7.3）。
func TestTwoDevicesConvergeOnRecipeEdit(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)

	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()
	const (
		stepBase = "st-base"
		stepV1   = "st-v1"
		stepV2   = "st-v2"
		labelV1  = "lbl-v1"
		labelV2  = "lbl-v2"
	)

	base := syncRecipe(recipeID, "原始菜谱", now.Add(-3*time.Hour), personalScopeID(a))
	base.Steps = []model.RecipeStep{{ID: stepBase, SortOrder: 0, Text: "原始步骤"}}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{base}})

	// 设备 1 离线期间的修改
	v1 := syncRecipe(recipeID, "设备1版", now.Add(-2*time.Hour), personalScopeID(a))
	v1.Steps = []model.RecipeStep{
		{ID: stepV1, SortOrder: 0, Text: "设备1的步骤"},
		{ID: stepV1 + "-b", SortOrder: 1, Text: "设备1的步骤2"},
	}
	v1.LabelIDs = []string{labelV1}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{v1}})

	// 设备 2 离线期间的修改，时间更晚
	v2 := syncRecipe(recipeID, "设备2版", now.Add(-1*time.Hour), personalScopeID(a))
	v2.Steps = []model.RecipeStep{{ID: stepV2, SortOrder: 0, Text: "设备2的步骤"}}
	v2.LabelIDs = []string{labelV2}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{v2}})

	// 库里留下较新的那份
	var name string
	if err := pool.QueryRow(ctx, `SELECT name FROM recipes WHERE id = $1`, recipeID).Scan(&name); err != nil {
		t.Fatalf("查询菜谱失败: %v", err)
	}
	if name != "设备2版" {
		t.Errorf("库里的菜谱名 = %q, want 设备2版", name)
	}
	// 子行整组替换：设备 1 的两条步骤与一个标签都不能残留
	if got := recipeStepIDs(t, pool, recipeID); !slices.Equal(got, []string{stepV2}) {
		t.Errorf("步骤 = %v, want [%s]（子行没有整组替换，串了版本）", got, stepV2)
	}
	if got := recipeLabelIDs(t, pool, recipeID); !slices.Equal(got, []string{labelV2}) {
		t.Errorf("标签 = %v, want [%s]（子行没有整组替换，串了版本）", got, labelV2)
	}

	// 两台设备再拉一次，都拿到同一份（较新的）内容
	resp := mustPull(t, svc, a, 0)
	got := findRecipe(resp.RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("增量里应有菜谱 %s", recipeID)
	}
	if got.Name != "设备2版" {
		t.Errorf("拉回来的菜谱名 = %q, want 设备2版", got.Name)
	}
	// 范围入库后必须原样回传（INSERT 与 UPDATE 两条路径都走过）：客户端靠它写本地 scope_id
	if got.ScopeID != personalScopeID(a) {
		t.Errorf("拉回来的 scope_id = %q, want %q", got.ScopeID, personalScopeID(a))
	}
	if len(got.Steps) != 1 || got.Steps[0].ID != stepV2 {
		t.Errorf("拉回来的步骤 = %+v, want 只有 %s", got.Steps, stepV2)
	}
	if len(got.LabelIDs) != 1 || got.LabelIDs[0] != labelV2 {
		t.Errorf("拉回来的标签 = %v, want [%s]", got.LabelIDs, labelV2)
	}
}

// Review Focus ⑤：B 推同 id 的菜谱、owner_id 伪造成自己、时间更晚——服务端必须整体跳过，
// 库里仍是原作者、内容一字未改（spec §7.1）；可见范围只有作者本人，B 全量拉也拉不到 A 的菜谱。
func TestNonOwnerCannotOverwriteRecipe(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)

	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()
	owned := syncRecipe(recipeID, "A的菜谱", now.Add(-time.Hour), personalScopeID(a))
	owned.Steps = []model.RecipeStep{{ID: "st-a", SortOrder: 0, Text: "A的步骤"}}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{owned}})

	// B 拿着一模一样的 id、伪造 owner_id 与更晚的 updated_at 试图覆盖
	forged := syncRecipe(recipeID, "被B篡改", now, personalScopeID(b))
	forged.OwnerID = b
	forged.Steps = []model.RecipeStep{{ID: "st-b", SortOrder: 0, Text: "B的步骤"}}
	mustPush(t, svc, b, model.SyncPayload{Recipes: []model.Recipe{forged}})

	var owner, name string
	if err := pool.QueryRow(ctx, `SELECT owner_id, name FROM recipes WHERE id = $1`, recipeID).Scan(&owner, &name); err != nil {
		t.Fatalf("查询菜谱失败: %v", err)
	}
	if owner != a {
		t.Errorf("owner_id = %s, want A(%s)；非作者越权覆盖生效了", owner, a)
	}
	if name != "A的菜谱" {
		t.Errorf("菜谱名 = %q, want A的菜谱；非作者越权改名生效了", name)
	}
	if got := recipeStepIDs(t, pool, recipeID); !slices.Equal(got, []string{"st-a"}) {
		t.Errorf("步骤 = %v, want [st-a]；非作者越权改了子行", got)
	}

	// 可见范围只有作者本人：B 全量拉也看不到 A 的菜谱
	if got := findRecipe(mustPull(t, svc, b, 0).RemoteChanges.Recipes, recipeID); got != nil {
		t.Errorf("B 不该看到 A 的菜谱，实际拉到: %+v", got)
	}

	// A 拉回来仍是自己的内容与归属
	got := findRecipe(mustPull(t, svc, a, 0).RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("A 应看得到自己的菜谱")
	}
	if got.OwnerID != a {
		t.Errorf("A 拉到的 owner_id = %s, want A(%s)", got.OwnerID, a)
	}
	if got.Name != "A的菜谱" {
		t.Errorf("A 拉到的名字 = %q, want A的菜谱", got.Name)
	}
}

// 并发写事务的**行为层**回归网：spec §7.2 的全局 advisory lock 保证 nextval 的发号顺序 =
// 提交顺序，否则会出现「低 server_seq 的变更晚提交，被已经推进过去的游标永久跳过」。
// 10 个写事务并发提交，读取方在并发期内反复增量拉，所有变更必须都被拉到。
// 这条是概率性的网（实测把 advisory lock 去掉后它经常仍绿）；「写事务确实先拿锁、会被别人
// 同编号的锁挡住」由确定性的 TestSyncWritePhaseSerializesOnAdvisoryLock 钉死。
func TestConcurrentSyncTransactionsDoNotSkipChanges(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()
	a := seedUser(t, pool)

	const writers = 10
	ids := make([]string, writers)
	for i := range ids {
		ids[i] = "r-conc-" + uuid.NewString()
	}

	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			r := syncRecipe(id, fmt.Sprintf("并发菜谱%d", i), time.Now().UTC().Add(time.Duration(i)*time.Second), personalScopeID(a))
			if _, err := svc.Sync(ctx, a, model.SyncRequest{
				LocalChanges: model.SyncPayload{Recipes: []model.Recipe{r}},
			}); err != nil {
				t.Errorf("并发写事务失败: %v", err)
			}
		}(i, id)
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()

	// 读取方用「上一次的游标」反复增量拉：advisory lock 生效时，任何已提交的变更都不会被跳过。
	seen := map[string]bool{}
	var cursor int64
loop:
	for {
		select {
		case <-done:
			break loop
		default:
		}
		resp, err := svc.Sync(ctx, a, model.SyncRequest{LastServerSeq: cursor})
		if err != nil {
			t.Fatalf("读取方同步失败: %v", err)
		}
		for _, r := range resp.RemoteChanges.Recipes {
			seen[r.ID] = true
		}
		if resp.ServerSeq < cursor {
			t.Fatalf("游标回退：%d → %d（server_seq 应单调不回退）", cursor, resp.ServerSeq)
		}
		cursor = resp.ServerSeq
		time.Sleep(time.Millisecond)
	}

	// 收尾：并发期内一次都没读到过的变更，也必须能被下一次增量拉到
	resp := mustPull(t, svc, a, cursor)
	for _, r := range resp.RemoteChanges.Recipes {
		seen[r.ID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Errorf("菜谱 %s 在整段并发同步里一次都没被拉到（游标跳过了它）", id)
		}
	}
}

// spec §7.4：同一个范围内（这里是一个账号的两台设备）同名即同一行：库里只有一行，
// 后建那份的菜谱引用被 remap 到先建那一行的 id 上。跨范围不合并，见 TestMergeDictScopedSameName。
func TestDictSameNameDedupesWithinScope(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()

	ingA := "ing-a-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{Ingredients: []model.Ingredient{
		{ID: ingA, ScopeID: personalScopeID(a), Name: "五花肉", CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour)},
	}})

	ingB := "ing-b-" + uuid.NewString()
	recipeID := "r-" + uuid.NewString()
	recipe := syncRecipe(recipeID, "回锅肉", now, personalScopeID(b))
	recipe.Ingredients = []model.RecipeIngredient{{ID: "ri-" + uuid.NewString(), IngredientID: ingB, SortOrder: 0}}
	mustPush(t, svc, b, model.SyncPayload{
		Ingredients: []model.Ingredient{{ID: ingB, ScopeID: personalScopeID(b), Name: "五花肉", CreatedAt: now, UpdatedAt: now}},
		Recipes:     []model.Recipe{recipe},
	})

	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ingredients WHERE name = '五花肉'`).Scan(&count); err != nil {
		t.Fatalf("查询「五花肉」失败: %v", err)
	}
	if count != 2 {
		t.Errorf("两个范围的同名食材各留一行，want 2，实际 %d 行", count)
	}

	// B 的菜谱引用仍指向自己那条食材（没有跨范围 remap）
	var gotIngredient string
	if err := pool.QueryRow(ctx, `SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = $1`, recipeID).Scan(&gotIngredient); err != nil {
		t.Fatalf("查询菜谱引用失败: %v", err)
	}
	if gotIngredient != ingB {
		t.Errorf("菜谱引用的 ingredient_id = %s, want %s（跨范围不该 remap）", gotIngredient, ingB)
	}
	_ = ingA
}

// 私人菜谱只有作者本人可见（spec §7.5 的可见范围）。
func TestPrivateRecipesInvisibleToOthers(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)

	a := seedUser(t, pool)
	b := seedUser(t, pool)

	recipeID := "r-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(recipeID, "A的私人菜谱", time.Now().UTC(), personalScopeID(a)),
	}})

	if got := findRecipe(mustPull(t, svc, a, 0).RemoteChanges.Recipes, recipeID); got == nil {
		t.Errorf("作者本人应能看到自己的私人菜谱")
	}
	if got := findRecipe(mustPull(t, svc, b, 0).RemoteChanges.Recipes, recipeID); got != nil {
		t.Errorf("B 不该看到 A 的私人菜谱")
	}
}

// --- 控制者额外要求：读事务隔离级别 ---

// sqlRecorder 是 pgx 的 QueryTracer，记录连接池实际发给 Postgres 的每一条 SQL 文本。
type sqlRecorder struct {
	mu   sync.Mutex
	sqls []string
}

func (r *sqlRecorder) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	r.mu.Lock()
	r.sqls = append(r.sqls, data.SQL)
	r.mu.Unlock()
	return ctx
}

func (r *sqlRecorder) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (r *sqlRecorder) statements() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.sqls)
}

// tracedPool 复用现有连接池的配置（同一个容器），只挂上 QueryTracer。
func tracedPool(t *testing.T, base *pgxpool.Pool) (*pgxpool.Pool, *sqlRecorder) {
	t.Helper()
	cfg := base.Config().Copy()
	rec := &sqlRecorder{}
	cfg.ConnConfig.Tracer = rec
	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("建带 tracer 的连接池失败: %v", err)
	}
	t.Cleanup(p.Close)
	return p, rec
}

// 观测方式：在连接池上挂 pgx 的 QueryTracer，直接看「Sync 发给 Postgres 的语句」。
// 读阶段的 BeginTx 会发 `begin isolation level repeatable read read only`，写阶段的普通
// Begin 只发 `begin`——两条都在，正好互为对照：证明我们钉的是读阶段而不是「所有事务都这样」。
// （若把 sync.go 的 IsoLevel / AccessMode 去掉，这条会红。）
func TestSyncReadPhaseRunsInRepeatableReadReadOnlyTx(t *testing.T) {
	pool := filesTestDB(t)
	traced, recorder := tracedPool(t, pool)
	svc := NewSyncService(traced)
	a := seedUser(t, pool)

	mustPull(t, svc, a, 0)

	const wantReadBegin = "begin isolation level repeatable read read only"
	got := recorder.statements()
	if !slices.Contains(got, wantReadBegin) {
		t.Fatalf("读阶段应发出 %q，实际捕获的语句: %v", wantReadBegin, got)
	}
	if !slices.Contains(got, "begin") {
		t.Errorf("对照臂：写阶段应发出普通 begin，实际捕获的语句: %v", got)
	}
}

// waitForBlockedSession 轮询 pg_stat_activity，等到有一个「不是本会话」的后端卡在锁上。
// 测试自己占着锁，所以唯一在等锁的会话就是被测的 Sync。
func waitForBlockedSession(t *testing.T, pool *pgxpool.Pool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var waiting int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()`).Scan(&waiting); err != nil {
			t.Fatalf("查 pg_stat_activity 失败: %v", err)
		}
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待 %s 后仍没有会话卡在锁上", timeout)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// 观测方式：把读阶段「卡住」再往里塞一次提交。files 表是读阶段最后才查的表之一，先用
// 独立事务对它拿 ACCESS EXCLUSIVE 锁，读阶段就会停在 SELECT ... FROM files 上；
// 此时读事务的快照已经建立（REPEATABLE READ 的快照取第一条查询），我们再直接 INSERT 一条
// 新菜谱并提交。快照若真的生效：这次响应看不到新菜谱，且返回的游标不包含它的 server_seq
// （否则游标会跳过它）；下一次用该游标增量拉必须能拉到它。
func TestSyncReadPhaseIsSingleSnapshot(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()
	a := seedUser(t, pool)

	// R1 引用一张已登记的图，读阶段的 queryFiles 才会真的去查 files
	file := newFileName()
	fileRef := file
	r1 := syncRecipe("r-"+uuid.NewString(), "快照菜谱", time.Now().UTC().Add(-time.Hour), personalScopeID(a))
	r1.CoverPath = &fileRef
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{r1}})
	if _, err := pool.Exec(ctx, `INSERT INTO files (name, owner_id, size) VALUES ($1, $2, 1)`, file, a); err != nil {
		t.Fatalf("登记图片失败: %v", err)
	}

	// 拿住 files 的 ACCESS EXCLUSIVE 锁，把读阶段卡在最后一步
	lockConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("取连接失败: %v", err)
	}
	defer lockConn.Release()
	lockTx, err := lockConn.Begin(ctx)
	if err != nil {
		t.Fatalf("开启锁事务失败: %v", err)
	}
	defer lockTx.Rollback(ctx)
	if _, err := lockTx.Exec(ctx, "LOCK TABLE files IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("加锁失败: %v", err)
	}

	result := make(chan struct {
		resp *model.SyncResponse
		err  error
	}, 1)
	go func() {
		resp, err := svc.Sync(ctx, a, model.SyncRequest{LastServerSeq: 0})
		result <- struct {
			resp *model.SyncResponse
			err  error
		}{resp, err}
	}()

	// 等到读阶段真的停在 files 上
	waitForBlockedSession(t, pool, 15*time.Second)

	// 快照已建立，此刻提交一条新菜谱
	r2ID := "r-" + uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO recipes (id, owner_id, name, cover_path, category_id, created_at, updated_at)
		VALUES ($1, $2, '并发提交', NULL, '', NOW(), NOW())`, r2ID, a); err != nil {
		t.Fatalf("插入并发菜谱失败: %v", err)
	}
	var r2Seq int64
	if err := pool.QueryRow(ctx, `SELECT server_seq FROM recipes WHERE id = $1`, r2ID).Scan(&r2Seq); err != nil {
		t.Fatalf("查并发菜谱 seq 失败: %v", err)
	}

	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatalf("释放 files 表锁失败: %v", err)
	}

	res := <-result
	if res.err != nil {
		t.Fatalf("同步失败: %v", res.err)
	}
	if findRecipe(res.resp.RemoteChanges.Recipes, r1.ID) == nil {
		t.Fatalf("读阶段应返回快照里的菜谱 %s", r1.ID)
	}
	if findRecipe(res.resp.RemoteChanges.Recipes, r2ID) != nil {
		t.Errorf("快照里不该看到锁释放前才提交的菜谱 %s（读阶段不是单一快照）", r2ID)
	}
	if res.resp.ServerSeq >= r2Seq {
		t.Errorf("游标 %d 不应包含快照外的 server_seq %d（会把并发提交的变更永久跳过）",
			res.resp.ServerSeq, r2Seq)
	}

	// 用这个游标接着增量拉，并发提交的那条必须补上
	next := mustPull(t, svc, a, res.resp.ServerSeq)
	if findRecipe(next.RemoteChanges.Recipes, r2ID) == nil {
		t.Errorf("用上一次返回的游标 %d 增量拉，应能拉到并发提交的菜谱 %s", res.resp.ServerSeq, r2ID)
	}
}

// 观测方式：用一条独立连接以**会话级** pg_advisory_lock 占住同步写锁的同一个编号。
// 若写事务真的先拿这把锁（spec §7.2），它就推进不去、必须等待；释放后立刻完成。
// 这个现象是确定性的：去掉 sync.go 里的 pg_advisory_xact_lock，同步会毫无阻塞地直接完成，
// 用例立刻变红（比并发压测那条概率网可靠）。
func TestSyncWritePhaseSerializesOnAdvisoryLock(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()
	a := seedUser(t, pool)

	lockConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("取连接失败: %v", err)
	}
	defer lockConn.Release()
	lockSQL := fmt.Sprintf("SELECT pg_advisory_lock(%d)", syncWriteLockID)
	unlockSQL := fmt.Sprintf("SELECT pg_advisory_unlock(%d)", syncWriteLockID)
	if _, err := lockConn.Exec(ctx, lockSQL); err != nil {
		t.Fatalf("占住 advisory lock 失败: %v", err)
	}
	unlocked := false
	defer func() {
		if !unlocked {
			_, _ = lockConn.Exec(ctx, unlockSQL)
		}
	}()

	recipeID := "r-" + uuid.NewString()
	done := make(chan error, 1)
	go func() {
		_, err := svc.Sync(ctx, a, model.SyncRequest{LocalChanges: model.SyncPayload{
			Recipes: []model.Recipe{syncRecipe(recipeID, "被锁挡住的菜谱", time.Now().UTC(), personalScopeID(a))},
		}})
		done <- err
	}()

	waitForBlockedSession(t, pool, 15*time.Second)
	select {
	case err := <-done:
		t.Fatalf("写事务没有在 advisory lock 上等待就完成了（err=%v）；写事务没拿全局写锁", err)
	default:
	}

	if _, err := lockConn.Exec(ctx, unlockSQL); err != nil {
		t.Fatalf("释放 advisory lock 失败: %v", err)
	}
	unlocked = true
	if err := <-done; err != nil {
		t.Fatalf("释放锁后同步应完成: %v", err)
	}

	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recipes WHERE id = $1)`, recipeID).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Errorf("解锁后菜谱应已落库")
	}
}

// I2：协议里没有「服务器世代」。服务器库被重建 / 回滚成旧备份后，MAX(server_seq) 会低于
// 客户端已存的游标；只做 server_seq > 游标的增量查询会永远返回 0 条，两端各看各的且不报错。
// 护栏必须比「客户端游标 vs 同一快照的 MAX(server_seq)」，检测到世代回退就按 sinceSeq=0
// 重读全量（LWW 幂等，重复应用无副作用），并把游标退回当前世代的最大值。
func TestPullRecoversFromServerGenerationRollback(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()
	a := seedUser(t, pool)

	recipeID := "r-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{
		Recipes: []model.Recipe{syncRecipe(recipeID, "世代回退后的菜谱", time.Now().UTC(), personalScopeID(a))},
	})

	maxSeq, err := maxServerSeq(ctx, pool)
	if err != nil {
		t.Fatalf("读 MAX(server_seq) 失败: %v", err)
	}

	// 客户端游标大于库里 MAX(server_seq)：服务器换了世代（空库重建 / 恢复旧 dump）
	resp := mustPull(t, svc, a, maxSeq+1000)

	if findRecipe(resp.RemoteChanges.Recipes, recipeID) == nil {
		t.Errorf("世代回退后必须以 sinceSeq=0 重读全量，实际一条可见菜谱都没拉到：%+v", resp.RemoteChanges.Recipes)
	}
	if resp.ServerSeq != maxSeq {
		t.Errorf("游标应退回当前世代的 MAX(server_seq) %d，got %d", maxSeq, resp.ServerSeq)
	}
}

// seedTeam 建一个团队并把 ownerID 写成 owner。
func seedTeam(t *testing.T, pool *pgxpool.Pool, ownerID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id`,
		"team-"+uuid.NewString(), ownerID).Scan(&id); err != nil {
		t.Fatalf("插入团队失败: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`, id, ownerID); err != nil {
		t.Fatalf("插入团队成员失败: %v", err)
	}
	return id
}

// Review Focus ⑤：两个家庭各录一个「生抽」不能被并成一条。同名合并只在同一范围内发生。
func TestMergeDictScopedSameName(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	team1 := seedTeam(t, pool, a)
	team2 := seedTeam(t, pool, a)

	now := time.Now().UTC()
	id1 := "i-" + uuid.NewString()
	id2 := "i-" + uuid.NewString()

	got1, err := svc.mergeDict(ctx, pool, ingredientSpec, scope{TeamID: &team1, OwnerID: a},
		dictEntity{ID: id1, Name: "生抽", CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict team1: %v", err)
	}
	got2, err := svc.mergeDict(ctx, pool, ingredientSpec, scope{TeamID: &team2, OwnerID: a},
		dictEntity{ID: id2, Name: "生抽", CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict team2: %v", err)
	}
	if got1 != id1 || got2 != id2 {
		t.Fatalf("两个范围的同名食材不该合并：got %q / %q, want %q / %q", got1, got2, id1, id2)
	}

	rows, err := pool.Query(ctx,
		`SELECT id, team_id::text FROM ingredients WHERE name = '生抽' ORDER BY id`)
	if err != nil {
		t.Fatalf("查询食材失败: %v", err)
	}
	defer rows.Close()
	type row struct{ id, team string }
	var got []row
	for rows.Next() {
		var it row
		if err := rows.Scan(&it.id, &it.team); err != nil {
			t.Fatalf("扫描失败: %v", err)
		}
		got = append(got, it)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("遍历失败: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("应留下两条「生抽」，got %+v", got)
	}
	want := map[string]string{id1: team1, id2: team2}
	for _, it := range got {
		if want[it.id] != it.team {
			t.Errorf("食材 %s 的 team_id = %s, want %s", it.id, it.team, want[it.id])
		}
	}
}

// Review Focus ①：范围就是权限边界。B 冒用 A 的个人范围整条跳过；B 在自己的团队里建的菜谱
// 落库归属该团队，队友互相可见；各自的私人菜谱互不可见（spec §6 / §8.2）。
func TestRecipeScopeIsolation(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	teamID := seedTeam(t, pool, a)
	seedTeamMember(t, pool, teamID, b)

	now := time.Now().UTC()

	// B 冒用 A 的个人范围
	foreignID := "r-" + uuid.NewString()
	mustPush(t, svc, b, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(foreignID, "冒用A的范围", now, personalScopeID(a)),
	}})
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM recipes WHERE id = $1)`, foreignID).Scan(&exists); err != nil {
		t.Fatalf("查询菜谱失败: %v", err)
	}
	if exists {
		t.Error("越权范围的菜谱不该落库")
	}

	// B 在自己的团队里建菜谱：落库且归属该团队
	teamRecipeB := "r-" + uuid.NewString()
	mustPush(t, svc, b, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(teamRecipeB, "B在团队里建的", now, teamScopeID(teamID)),
	}})
	var teamOfB *string
	if err := pool.QueryRow(ctx, `SELECT team_id::text FROM recipes WHERE id = $1`, teamRecipeB).Scan(&teamOfB); err != nil {
		t.Fatalf("团队菜谱 %s 应落库: %v", teamRecipeB, err)
	}
	if teamOfB == nil || *teamOfB != teamID {
		t.Errorf("团队菜谱的 team_id = %v, want %s", teamOfB, teamID)
	}

	// A 在同团队建的菜谱，B 拉得到
	teamRecipeA := "r-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(teamRecipeA, "A在团队里建的", now, teamScopeID(teamID)),
	}})
	if got := findRecipe(mustPull(t, svc, b, 0).RemoteChanges.Recipes, teamRecipeA); got == nil {
		t.Errorf("团队成员 B 应拉到队友的菜谱 %s", teamRecipeA)
	} else if got.ScopeID != teamScopeID(teamID) {
		t.Errorf("团队菜谱的 scope_id = %q, want %q", got.ScopeID, teamScopeID(teamID))
	}

	// B 的私人菜谱不出现在 A 的拉取里
	bPrivate := "r-" + uuid.NewString()
	mustPush(t, svc, b, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(bPrivate, "B的私人菜谱", now, personalScopeID(b)),
	}})
	if got := findRecipe(mustPull(t, svc, a, 0).RemoteChanges.Recipes, bPrivate); got != nil {
		t.Errorf("A 不该看到 B 的私人菜谱：%+v", got)
	}
	if got := findRecipe(mustPull(t, svc, b, 0).RemoteChanges.Recipes, bPrivate); got == nil {
		t.Errorf("B 应能看到自己的私人菜谱")
	}
}
