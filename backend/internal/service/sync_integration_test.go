// 同步服务的真库集成测试：复用 files_test.go 的容器/seed 辅助（同一个 postgres 容器，
// 各用例用随机 UUID 的 id 隔离数据）。这些用例吃的是真 SQL + 真事务，覆盖 spec
// §7.2（整条合并）、§7.3（子行整组替换）、§7.4（字典同名合并）、§7.5（快照游标）、
// §9.4（加入团队要清游标）这几条只有真库才验得出的规格。
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

// syncRecipe 造一条待同步的菜谱，三个子集合给空切片而不是 nil：空数组才表达得出「清空」。
func syncRecipe(id, name string, updatedAt time.Time, teamID *string) model.Recipe {
	return model.Recipe{
		ID:          id,
		Name:        name,
		TeamID:      teamID,
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

// Review Focus ①：同一用户的两台设备离线各改同一条团队菜谱，服务端必须留下较新的那一份，
// 且三张子表整组来自同一版本——不是把两版的子行拼起来（spec §7.3）。
func TestTwoDevicesConvergeOnRecipeEdit(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)

	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()
	const (
		stepBase = "st-base"
		stepV1   = "st-v1"
		stepV2   = "st-v2"
		labelV1  = "lbl-v1"
		labelV2  = "lbl-v2"
	)

	base := syncRecipe(recipeID, "原始菜谱", now.Add(-3*time.Hour), &team)
	base.Steps = []model.RecipeStep{{ID: stepBase, SortOrder: 0, Text: "原始步骤"}}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{base}})

	// 设备 1 离线期间的修改
	v1 := syncRecipe(recipeID, "设备1版", now.Add(-2*time.Hour), &team)
	v1.Steps = []model.RecipeStep{
		{ID: stepV1, SortOrder: 0, Text: "设备1的步骤"},
		{ID: stepV1 + "-b", SortOrder: 1, Text: "设备1的步骤2"},
	}
	v1.LabelIDs = []string{labelV1}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{v1}})

	// 设备 2 离线期间的修改，时间更晚
	v2 := syncRecipe(recipeID, "设备2版", now.Add(-1*time.Hour), &team)
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
	if len(got.Steps) != 1 || got.Steps[0].ID != stepV2 {
		t.Errorf("拉回来的步骤 = %+v, want 只有 %s", got.Steps, stepV2)
	}
	if len(got.LabelIDs) != 1 || got.LabelIDs[0] != labelV2 {
		t.Errorf("拉回来的标签 = %v, want [%s]", got.LabelIDs, labelV2)
	}
}

// Review Focus ② + spec §9.4 的根因钉子：后加入的人能拿到存量团队数据，前提是客户端把
// last_server_seq 清 0。用例显式验证「用加入前的旧游标拉，一条都拉不到」——这就是必须清游标的原因。
func TestJoinTeamThenPullExistingRecipes(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)

	// A 先在团队里录 5 道菜，此刻的全局游标就是 B「加入前」的旧游标
	now := time.Now().UTC()
	ids := make([]string, 5)
	recipes := make([]model.Recipe, 5)
	for i := range recipes {
		ids[i] = "r-" + uuid.NewString()
		recipes[i] = syncRecipe(ids[i], fmt.Sprintf("团队菜谱%d", i), now.Add(time.Duration(i)*time.Second), &team)
	}
	joinCursor := mustPush(t, svc, a, model.SyncPayload{Recipes: recipes}).ServerSeq

	// B 此刻才加入团队
	joinTeam(t, pool, team, b)

	// 旧游标拉：一条都拉不到（不报错，只是全空）——回归网：若这里能拉到，§9.4 就白写了
	old := mustPull(t, svc, b, joinCursor)
	if len(old.RemoteChanges.Recipes) != 0 {
		t.Errorf("B 用加入前的旧游标应一条菜谱都拉不到，实际 %d 条: %v",
			len(old.RemoteChanges.Recipes), recipeIDs(old.RemoteChanges.Recipes))
	}

	// 清 0 全量重拉：5 条团队菜谱都在
	fresh := mustPull(t, svc, b, 0)
	got := map[string]bool{}
	for _, r := range fresh.RemoteChanges.Recipes {
		got[r.ID] = true
	}
	for _, id := range ids {
		if !got[id] {
			t.Errorf("B 清 0 重拉后缺少团队菜谱 %s", id)
		}
	}
	// B 只在这一个团队里，所以全量重拉应恰好是这 5 条
	if len(fresh.RemoteChanges.Recipes) != 5 {
		t.Errorf("B 清 0 重拉应恰好拿到 5 条团队菜谱，实际 %d 条: %v",
			len(fresh.RemoteChanges.Recipes), recipeIDs(fresh.RemoteChanges.Recipes))
	}
}

func recipeIDs(recipes []model.Recipe) []string {
	ids := make([]string, 0, len(recipes))
	for _, r := range recipes {
		ids = append(ids, r.ID)
	}
	return ids
}

// Review Focus ⑤：同团队成员推同 id 的菜谱、owner_id 伪造成自己、时间更晚——服务端必须整体跳过，
// 库里仍是原作者、内容一字未改（spec §7.1）。
func TestNonOwnerCannotOverwriteRecipe(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)
	joinTeam(t, pool, team, b)

	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()
	owned := syncRecipe(recipeID, "A的菜谱", now.Add(-time.Hour), &team)
	owned.Steps = []model.RecipeStep{{ID: "st-a", SortOrder: 0, Text: "A的步骤"}}
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{owned}})

	// B 在团队里（team 校验放行），伪造 owner_id 与更晚的 updated_at 试图覆盖
	forged := syncRecipe(recipeID, "被B篡改", now, &team)
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

	// B 拉回来看到的仍是 A 的内容与归属
	resp := mustPull(t, svc, b, 0)
	got := findRecipe(resp.RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("团队成员应看得到该菜谱")
	}
	if got.OwnerID != a {
		t.Errorf("B 拉到的 owner_id = %s, want A(%s)", got.OwnerID, a)
	}
	if got.Name != "A的菜谱" {
		t.Errorf("B 拉到的名字 = %q, want A的菜谱", got.Name)
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
			r := syncRecipe(id, fmt.Sprintf("并发菜谱%d", i), time.Now().UTC().Add(time.Duration(i)*time.Second), nil)
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

// spec §7.4：字典是全局共享的，同名即同一行。A、B 各自建「五花肉」→
// 库里只有一行，且 B 的菜谱引用被 remap 到 A 那一行的 id 上。
func TestDictSameNameDedupesAcrossUsers(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()

	ingA := "ing-a-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{Ingredients: []model.Ingredient{
		{ID: ingA, Name: "五花肉", CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour)},
	}})

	ingB := "ing-b-" + uuid.NewString()
	recipeID := "r-" + uuid.NewString()
	recipe := syncRecipe(recipeID, "回锅肉", now, nil)
	recipe.Ingredients = []model.RecipeIngredient{{ID: "ri-" + uuid.NewString(), IngredientID: ingB, SortOrder: 0}}
	mustPush(t, svc, b, model.SyncPayload{
		Ingredients: []model.Ingredient{{ID: ingB, Name: "五花肉", CreatedAt: now, UpdatedAt: now}},
		Recipes:     []model.Recipe{recipe},
	})

	var rowID string
	if err := pool.QueryRow(ctx, `SELECT id FROM ingredients WHERE name = '五花肉'`).Scan(&rowID); err != nil {
		t.Fatalf("查询「五花肉」失败: %v", err)
	}
	if rowID != ingA {
		t.Errorf("同名食材应合并到先建的 %s，实际 %s", ingA, rowID)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ingredients WHERE name = '五花肉'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("同名食材应只有一行，实际 %d 行", count)
	}

	// B 被丢弃的那个 id 不能单独存在，且菜谱引用必须被 remap 到存活的那一行
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM ingredients WHERE id = $1)`, ingB).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Errorf("被合并掉的食材 id %s 不应单独存在", ingB)
	}
	var gotIngredient string
	if err := pool.QueryRow(ctx, `SELECT ingredient_id FROM recipe_ingredients WHERE recipe_id = $1`, recipeID).Scan(&gotIngredient); err != nil {
		t.Fatalf("查询菜谱引用失败: %v", err)
	}
	if gotIngredient != ingA {
		t.Errorf("菜谱引用的 ingredient_id = %s, want %s（引用没有 remap）", gotIngredient, ingA)
	}
}

// 私人菜谱（team_id IS NULL）只有作者本人可见，团队队友也不行（spec §7.5 的可见范围）。
func TestPrivateRecipesInvisibleToOthers(t *testing.T) {
	pool := filesTestDB(t)
	svc := NewSyncService(pool)

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)
	joinTeam(t, pool, team, b)

	recipeID := "r-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{Recipes: []model.Recipe{
		syncRecipe(recipeID, "A的私人菜谱", time.Now().UTC(), nil),
	}})

	if got := findRecipe(mustPull(t, svc, a, 0).RemoteChanges.Recipes, recipeID); got == nil {
		t.Errorf("作者本人应能看到自己的私人菜谱")
	}
	if got := findRecipe(mustPull(t, svc, b, 0).RemoteChanges.Recipes, recipeID); got != nil {
		t.Errorf("B 与 A 同队，但不该看到 A 的私人菜谱")
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
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)

	// R1 引用一张已登记的图，读阶段的 queryFiles 才会真的去查 files
	file := newFileName()
	fileRef := file
	r1 := syncRecipe("r-"+uuid.NewString(), "快照菜谱", time.Now().UTC().Add(-time.Hour), &team)
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
		INSERT INTO recipes (id, owner_id, team_id, name, cover_path, category_id, created_at, updated_at)
		VALUES ($1, $2, NULL, '并发提交', NULL, '', NOW(), NOW())`, r2ID, a); err != nil {
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
			Recipes: []model.Recipe{syncRecipe(recipeID, "被锁挡住的菜谱", time.Now().UTC(), nil)},
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
	team := seedTeam(t, pool, a)
	joinTeam(t, pool, team, a)

	recipeID := "r-" + uuid.NewString()
	mustPush(t, svc, a, model.SyncPayload{
		Recipes: []model.Recipe{syncRecipe(recipeID, "世代回退后的菜谱", time.Now().UTC(), &team)},
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
