// 收藏 / 取消收藏的真库集成测试：复用 files_test.go 的容器与 seed 辅助、sync_integration_test.go 的同步辅助。
// 这组用例覆盖 spec §7.4 那条只有真 SQL 才验得出的规矩——收藏要把菜谱的 server_seq 推到最新，
// 否则游标已经推过它的客户端靠增量永远拉不到正文。
package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-cook/backend/internal/model"
)

// spec §7.4 / §13：A 公开一道菜，B 先同步一次把游标推过它，B 再收藏，B 用同一个游标同步必须拿到正文。
func TestFavoriteBumpsServerSeqSoLaggingClientsGetIt(t *testing.T) {
	pool := filesTestDB(t)
	syncSvc := NewSyncService(pool)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()

	recipe := syncRecipe(recipeID, "A的公开菜", now.Add(-time.Hour), 1)
	// 步骤 id 全局唯一（recipe_steps 的主键），用随机值避免与别的用例撞车。
	stepID := "st-" + uuid.NewString()
	recipe.Steps = []model.RecipeStep{{ID: stepID, SortOrder: 0, Text: "A的步骤"}}
	mustPush(t, syncSvc, a, model.SyncPayload{Recipes: []model.Recipe{recipe}})

	// B 先同步一次：还没收藏，看不到这条菜谱，但游标已经推过它的 server_seq。
	first := mustPull(t, syncSvc, b, 0)
	if findRecipe(first.RemoteChanges.Recipes, recipeID) != nil {
		t.Fatalf("B 收藏前不该看到 %s", recipeID)
	}

	if err := community.Favorite(ctx, b, recipeID); err != nil {
		t.Fatalf("收藏失败: %v", err)
	}

	// 用同一个游标增量拉取：只有 server_seq 被推进过，这条菜谱才会出现。
	second := mustPull(t, syncSvc, b, first.ServerSeq)
	got := findRecipe(second.RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("收藏后增量里应拉到 %s（server_seq 没被推进）", recipeID)
	}
	if len(got.Steps) != 1 || got.Steps[0].ID != stepID {
		t.Errorf("收藏拉回来的菜谱要带完整正文，got %+v", got.Steps)
	}
}

// 收藏是幂等的：连调两次不报错，库里仍只有一行。
func TestFavoriteIsIdempotent(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	recipeID := seedRecipe(t, pool, a, nil, false)
	if _, err := pool.Exec(ctx, `UPDATE recipes SET is_public = 1 WHERE id = $1`, recipeID); err != nil {
		t.Fatalf("公开菜谱失败: %v", err)
	}

	for i := 0; i < 2; i++ {
		if err := community.Favorite(ctx, b, recipeID); err != nil {
			t.Fatalf("第 %d 次收藏失败: %v", i+1, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM favorites WHERE user_id = $1 AND recipe_id = $2`, b, recipeID).Scan(&n); err != nil {
		t.Fatalf("统计收藏失败: %v", err)
	}
	if n != 1 {
		t.Errorf("收藏行数 = %d, want 1", n)
	}
}

// 私有菜谱不可收藏：对外是 404，服务层用 ErrRecipeNotVisible 表达（spec §8）。
func TestFavoritePrivateRecipeReturnsNotVisible(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	recipeID := seedRecipe(t, pool, a, nil, false) // is_public 默认 0

	err := community.Favorite(context.Background(), b, recipeID)
	if !errors.Is(err, ErrRecipeNotVisible) {
		t.Fatalf("收藏私有菜谱 err = %v, want ErrRecipeNotVisible", err)
	}
}

// 并发回归网（FOR UPDATE 修复的自检）：8 个用户同时收藏同一条热门菜谱必须全部成功。
// 旧实现取 FOR SHARE、同事务内再 UPDATE 同一行，共享锁升级会让并发收藏彼此互等，
// Postgres 判 40P01 deadlock detected（实测 20 并发时 16 次失败）。排他锁把它们串在行锁上
// （毫秒级排队），不再有第二条路可等，所以这个测试稳定成立。
// 超时上下文只为防挂死；正常路径每次收藏都在毫秒级完成。
func TestConcurrentFavoriteOnSameRecipeDoesNotDeadlock(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	a := seedUser(t, pool)
	recipeID := seedRecipe(t, pool, a, nil, false)
	if _, err := pool.Exec(ctx, `UPDATE recipes SET is_public = 1 WHERE id = $1`, recipeID); err != nil {
		t.Fatalf("公开菜谱失败: %v", err)
	}

	const n = 8
	users := make([]string, n)
	for i := range users {
		users[i] = seedUser(t, pool)
	}

	start := make(chan struct{}) // 拦住所有 goroutine，让它们尽量同时抢同一行的锁
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range users {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = community.Favorite(ctx, users[i], recipeID)
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("并发收藏第 %d 个失败（应排队而非死锁）: %v", i, err)
		}
	}

	var favors int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM favorites WHERE recipe_id = $1`, recipeID).Scan(&favors); err != nil {
		t.Fatalf("统计收藏失败: %v", err)
	}
	if favors != n {
		t.Errorf("收藏行数 = %d, want %d（并发下有收藏丢失）", favors, n)
	}
}

// 取消收藏幂等：没收藏过也能调；已收藏的调两次后行没了；且不推进 server_seq（spec §7.4）。
func TestUnfavoriteIsIdempotent(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)

	// 从没收藏过的随机 id 也能调
	if err := community.Unfavorite(ctx, b, "r-"+uuid.NewString()); err != nil {
		t.Fatalf("取消未收藏的菜谱失败: %v", err)
	}

	recipeID := seedRecipe(t, pool, a, nil, false)
	if _, err := pool.Exec(ctx, `UPDATE recipes SET is_public = 1 WHERE id = $1`, recipeID); err != nil {
		t.Fatalf("公开菜谱失败: %v", err)
	}
	if err := community.Favorite(ctx, b, recipeID); err != nil {
		t.Fatalf("收藏失败: %v", err)
	}

	var seqBefore int64
	if err := pool.QueryRow(ctx, `SELECT server_seq FROM recipes WHERE id = $1`, recipeID).Scan(&seqBefore); err != nil {
		t.Fatalf("读取 server_seq 失败: %v", err)
	}

	for i := 0; i < 2; i++ {
		if err := community.Unfavorite(ctx, b, recipeID); err != nil {
			t.Fatalf("第 %d 次取消收藏失败: %v", i+1, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM favorites WHERE user_id = $1 AND recipe_id = $2`, b, recipeID).Scan(&n); err != nil {
		t.Fatalf("统计收藏失败: %v", err)
	}
	if n != 0 {
		t.Errorf("取消收藏后收藏行数 = %d, want 0", n)
	}

	var seqAfter int64
	if err := pool.QueryRow(ctx, `SELECT server_seq FROM recipes WHERE id = $1`, recipeID).Scan(&seqAfter); err != nil {
		t.Fatalf("读取 server_seq 失败: %v", err)
	}
	if seqAfter != seqBefore {
		t.Errorf("取消收藏不该推进 server_seq：before = %d, after = %d", seqBefore, seqAfter)
	}
}

// 关注幂等：连调两次不报错、库里仍只有一行；Profile 以关注者视角看到的 Followed 为 true。
func TestFollowIsIdempotentAndProfileReflectsIt(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)

	for i := 0; i < 2; i++ {
		if err := community.Follow(ctx, a, b); err != nil {
			t.Fatalf("第 %d 次关注失败: %v", i+1, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM follows WHERE follower_id = $1 AND followee_id = $2`, a, b).Scan(&n); err != nil {
		t.Fatalf("统计关注失败: %v", err)
	}
	if n != 1 {
		t.Errorf("关注行数 = %d, want 1", n)
	}

	p, err := community.Profile(ctx, a, b)
	if err != nil {
		t.Fatalf("读资料失败: %v", err)
	}
	if !p.Followed {
		t.Errorf("A 关注了 B，Profile(A, B).Followed = false, want true")
	}
}

// 不能关注自己：服务层用 ErrSelfFollow 表达（spec §8，handler 映射 400）。
func TestFollowSelfReturnsErrSelfFollow(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)

	if err := community.Follow(ctx, a, a); !errors.Is(err, ErrSelfFollow) {
		t.Fatalf("关注自己 err = %v, want ErrSelfFollow", err)
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM follows WHERE follower_id = $1 AND followee_id = $1`, a).Scan(&n); err != nil {
		t.Fatalf("统计关注失败: %v", err)
	}
	if n != 0 {
		t.Errorf("关注自己后关注行数 = %d, want 0", n)
	}
}

// 关注不存在的用户 → ErrUserNotFound（handler 映射 404）。
func TestFollowUnknownUserReturnsErrUserNotFound(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	missing := uuid.NewString()
	if err := community.Follow(ctx, a, missing); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("关注不存在的用户 err = %v, want ErrUserNotFound", err)
	}
	if _, err := community.Profile(ctx, a, missing); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("读不存在的用户的资料 err = %v, want ErrUserNotFound", err)
	}
}

// PublicCount 只数公开且未删除的菜谱：私有与已删除的都不计。
func TestProfileCountsOnlyPublicRecipes(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	if _, err := pool.Exec(ctx,
		`UPDATE users SET nickname = '阿花', avatar_url = 'https://example.com/a.png' WHERE id = $1`, a); err != nil {
		t.Fatalf("更新用户失败: %v", err)
	}

	public1 := seedRecipe(t, pool, a, nil, false)
	public2 := seedRecipe(t, pool, a, nil, false)
	seedRecipe(t, pool, a, nil, false)                 // 私有
	deletedPublic := seedRecipe(t, pool, a, nil, true) // 已删除
	if _, err := pool.Exec(ctx,
		`UPDATE recipes SET is_public = 1 WHERE id = ANY($1)`, []string{public1, public2, deletedPublic}); err != nil {
		t.Fatalf("公开菜谱失败: %v", err)
	}

	p, err := community.Profile(ctx, b, a)
	if err != nil {
		t.Fatalf("读资料失败: %v", err)
	}
	if p.ID != a {
		t.Errorf("Profile.ID = %q, want %q", p.ID, a)
	}
	if p.Nickname != "阿花" {
		t.Errorf("Profile.Nickname = %q, want 阿花", p.Nickname)
	}
	if p.AvatarURL == nil || *p.AvatarURL != "https://example.com/a.png" {
		t.Errorf("Profile.AvatarURL = %v, want 头像地址", p.AvatarURL)
	}
	if p.Followed {
		t.Errorf("B 没关注 A，Profile(B, A).Followed = true, want false")
	}
	if p.PublicCount != 2 {
		t.Errorf("PublicCount = %d, want 2（私有与已删除的不计）", p.PublicCount)
	}
}

// --- 社区列表与详情（spec §8） ---

// seedCommunityRecipe 直接落库一条菜谱，updated_at 由调用方指定：列表按它倒序翻页，必须可控。
func seedCommunityRecipe(t *testing.T, pool *pgxpool.Pool, ownerID, name string, isPublic int16, updatedAt time.Time, deleted bool) string {
	t.Helper()
	var deletedAt *time.Time
	if deleted {
		now := time.Now()
		deletedAt = &now
	}
	id := "r-" + uuid.NewString()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO recipes (id, owner_id, is_public, name, category_id, created_at, updated_at, deleted_at)
		VALUES ($1, $2, $3, $4, '', $5, $5, $6)`,
		id, ownerID, isPublic, name, updatedAt, deletedAt); err != nil {
		t.Fatalf("插入菜谱失败: %v", err)
	}
	return id
}

func findCommunityRecipe(recipes []model.CommunityRecipe, id string) *model.CommunityRecipe {
	for i := range recipes {
		if recipes[i].ID == id {
			return &recipes[i]
		}
	}
	return nil
}

// 列表只列别人的公开菜谱：自己的公开菜谱不走社区列表（spec §8）。
func TestListExcludesOwnPublicRecipes(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	mine := seedCommunityRecipe(t, pool, a, "我的菜", 1, now, false)
	theirs := seedCommunityRecipe(t, pool, b, "别人的菜", 1, now.Add(-time.Minute), false)

	got, _, err := community.ListPublicRecipes(ctx, a, model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if findCommunityRecipe(got, mine) != nil {
		t.Errorf("列表不该包含自己的公开菜谱 %s", mine)
	}
	if findCommunityRecipe(got, theirs) == nil {
		t.Errorf("列表应包含别人的公开菜谱 %s", theirs)
	}
}

// 私有与已删除都不入列表：它们没资格出现在社区里。
func TestListExcludesPrivateAndDeleted(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	public := seedCommunityRecipe(t, pool, a, "公开", 1, now, false)
	private := seedCommunityRecipe(t, pool, a, "私有", 0, now.Add(-time.Minute), false)
	deleted := seedCommunityRecipe(t, pool, a, "已删", 1, now.Add(-2*time.Minute), true)

	got, _, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if findCommunityRecipe(got, public) == nil {
		t.Errorf("列表应包含公开菜谱 %s", public)
	}
	if findCommunityRecipe(got, private) != nil {
		t.Errorf("列表不该包含私有菜谱 %s", private)
	}
	if findCommunityRecipe(got, deleted) != nil {
		t.Errorf("列表不该包含已删除菜谱 %s", deleted)
	}
}

// 只看我关注的：followed_only 按 follows 收窄到被我关注的作者，默认视图仍能看到所有人。
func TestListFollowedOnlyReturnsOnlyFollowedAuthors(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	c := seedUser(t, pool)
	b := seedUser(t, pool)
	if err := community.Follow(ctx, b, a); err != nil {
		t.Fatalf("关注失败: %v", err)
	}
	now := time.Now().UTC()
	followed := seedCommunityRecipe(t, pool, a, "关注的人的菜", 1, now, false)
	stranger := seedCommunityRecipe(t, pool, c, "陌生人的菜", 1, now.Add(-time.Minute), false)

	got, _, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{FollowedOnly: true})
	if err != nil {
		t.Fatalf("只看关注列表失败: %v", err)
	}
	if findCommunityRecipe(got, followed) == nil {
		t.Errorf("只看关注时应包含我关注的人的菜谱 %s", followed)
	}
	if findCommunityRecipe(got, stranger) != nil {
		t.Errorf("只看关注时不该包含陌生人的菜谱 %s", stranger)
	}

	// 默认视图（followed_only = false）两人都要在：否则上面那条可能被「永远只返回关注的人」蒙混过关。
	all, _, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if findCommunityRecipe(all, followed) == nil || findCommunityRecipe(all, stranger) == nil {
		t.Errorf("默认列表应同时包含两人的菜谱，got %d 条", len(all))
	}
}

// 翻页：limit=2 造 3 条，第一页满且 hasMore，第二页只剩 1 条且 hasMore=false，两页合起来不重不漏。
func TestListPaginationReportsHasMore(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	var want []string
	for i := range 3 {
		want = append(want, seedCommunityRecipe(t, pool, a, fmt.Sprintf("菜%d", i), 1, now.Add(-time.Duration(i)*time.Minute), false))
	}

	// 测试库是所有用例共用的，必须按作者收窄（a 是本用例新造的用户），否则别的用例留下的公开菜谱会混进页码。
	first, hasMore, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{Limit: 2, AuthorID: a})
	if err != nil {
		t.Fatalf("第一页失败: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("第一页应返回 2 条，实际 %d", len(first))
	}
	if !hasMore {
		t.Errorf("还有第三条时 hasMore = false, want true")
	}

	second, hasMore, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{Limit: 2, Offset: 2, AuthorID: a})
	if err != nil {
		t.Fatalf("第二页失败: %v", err)
	}
	if len(second) != 1 {
		t.Fatalf("第二页应返回 1 条，实际 %d", len(second))
	}
	if hasMore {
		t.Errorf("没有更多时 hasMore = true, want false")
	}

	seen := map[string]bool{}
	for _, r := range append(first, second...) {
		seen[r.ID] = true
	}
	if len(seen) != len(want) {
		t.Errorf("两页合起来有 %d 条不重复菜谱，want %d", len(seen), len(want))
	}
	for _, id := range want {
		if !seen[id] {
			t.Errorf("翻页漏掉了菜谱 %s", id)
		}
	}
	// updated_at 倒序：第一条应是最近更新的菜0。
	if first[0].ID != want[0] {
		t.Errorf("第一页第一条 = %s, want %s（应按 updated_at 倒序）", first[0].ID, want[0])
	}
}

// 我收藏了的菜谱在列表里打上 favorited 标记，没收藏的不打。
func TestListMarksFavorited(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	favorited := seedCommunityRecipe(t, pool, a, "收藏的", 1, now, false)
	other := seedCommunityRecipe(t, pool, a, "没收藏的", 1, now.Add(-time.Minute), false)
	addFavorite(t, pool, b, favorited)

	got, _, err := community.ListPublicRecipes(ctx, b, model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if r := findCommunityRecipe(got, favorited); r == nil {
		t.Errorf("列表缺少收藏的菜谱 %s", favorited)
	} else if !r.Favorited {
		t.Errorf("已收藏菜谱的 Favorited = false, want true")
	}
	if r := findCommunityRecipe(got, other); r == nil {
		t.Errorf("列表缺少菜谱 %s", other)
	} else if r.Favorited {
		t.Errorf("未收藏菜谱的 Favorited = true, want false")
	}
}

// 详情要能离线渲染：菜谱引用的字典行即使 server_seq 很老（三天前建的）也必须随详情一起回来。
func TestGetPublicRecipeReturnsDictRowsForOfflineRender(t *testing.T) {
	pool := filesTestDB(t)
	syncSvc := NewSyncService(pool)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	now := time.Now().UTC()
	recipeID := "r-" + uuid.NewString()
	ingredientID := "ing-" + uuid.NewString()
	unitID := "u-" + uuid.NewString()
	labelID := "l-" + uuid.NewString()

	// 三天前建的字典行，server_seq 给 0：任何增量游标都早已推过它们，正常同步不会再下发。
	// 详情按引用反查补齐，与 seq 无关，所以必须原样带回来（客户端离线渲染要外键行）。
	old := now.Add(-72 * time.Hour)
	// 字典名字必须全局唯一：别的用例（如同名合并）靠固定名字查库，名字撞车会污染它们。
	if _, err := pool.Exec(ctx,
		`INSERT INTO ingredients (id, name, created_at, updated_at, server_seq) VALUES ($1, $2, $3, $3, 0)`,
		ingredientID, "食材-"+uuid.NewString(), old); err != nil {
		t.Fatalf("插入食材失败: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO units (id, name, created_at, updated_at, server_seq) VALUES ($1, $2, $3, $3, 0)`,
		unitID, "单位-"+uuid.NewString(), old); err != nil {
		t.Fatalf("插入单位失败: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO labels (id, name, kind, created_at, updated_at, server_seq) VALUES ($1, $2, 'category', $3, $3, 0)`,
		labelID, "标签-"+uuid.NewString(), old); err != nil {
		t.Fatalf("插入标签失败: %v", err)
	}

	recipe := syncRecipe(recipeID, "A的公开菜", now, 1)
	recipe.CategoryID = labelID
	recipe.LabelIDs = []string{labelID}
	recipe.Ingredients = []model.RecipeIngredient{{ID: "ri-" + uuid.NewString(), IngredientID: ingredientID, UnitID: &unitID, SortOrder: 0}}
	recipe.Steps = []model.RecipeStep{{ID: "st-" + uuid.NewString(), SortOrder: 0, Text: "切块"}}
	mustPush(t, syncSvc, a, model.SyncPayload{Recipes: []model.Recipe{recipe}})

	payload, err := community.GetPublicRecipe(ctx, b, recipeID)
	if err != nil {
		t.Fatalf("读公开菜谱详情失败: %v", err)
	}
	if len(payload.Recipes) != 1 {
		t.Fatalf("详情应返回 1 条菜谱，实际 %d", len(payload.Recipes))
	}
	got := payload.Recipes[0]
	if got.ID != recipeID || got.OwnerID != a || got.Name != "A的公开菜" {
		t.Errorf("详情菜谱 = %+v, want id=%s owner=%s", got, recipeID, a)
	}
	if len(got.Steps) != 1 || got.Steps[0].Text != "切块" {
		t.Errorf("详情要带步骤子行，got %+v", got.Steps)
	}
	if len(got.Ingredients) != 1 || got.Ingredients[0].IngredientID != ingredientID {
		t.Errorf("详情要带食材子行，got %+v", got.Ingredients)
	}
	if !slices.ContainsFunc(payload.Ingredients, func(it model.Ingredient) bool { return it.ID == ingredientID }) {
		t.Errorf("详情必须补齐引用的食材字典行 %s，got %+v", ingredientID, payload.Ingredients)
	}
	if !slices.ContainsFunc(payload.Units, func(it model.Unit) bool { return it.ID == unitID }) {
		t.Errorf("详情必须补齐引用的单位字典行 %s，got %+v", unitID, payload.Units)
	}
	if !slices.ContainsFunc(payload.Labels, func(it model.Label) bool { return it.ID == labelID }) {
		t.Errorf("详情必须补齐引用的标签字典行 %s，got %+v", labelID, payload.Labels)
	}

	// 作者读自己的公开菜谱同样要成功：公开条件只有「公开且未删」，排除自己只是列表的规矩。
	if own, err := community.GetPublicRecipe(ctx, a, recipeID); err != nil || len(own.Recipes) != 1 {
		t.Errorf("作者读自己的公开菜谱详情 err=%v recipes=%d, want 1", err, len(own.Recipes))
	}

	// 没有任何引用的菜谱：详情里五个集合必须是空切片而不是 nil（客户端拿去直接落库，null 会炸）。
	bareID := "r-" + uuid.NewString()
	mustPush(t, syncSvc, a, model.SyncPayload{Recipes: []model.Recipe{syncRecipe(bareID, "A的清水菜", now.Add(time.Minute), 1)}})
	bare, err := community.GetPublicRecipe(ctx, b, bareID)
	if err != nil {
		t.Fatalf("读无引用菜谱详情失败: %v", err)
	}
	if bare.Ingredients == nil || bare.Units == nil || bare.Labels == nil || bare.Recipes == nil || bare.Files == nil {
		t.Errorf("空载荷集合必须是空切片而非 nil: %+v", bare)
	}
	if len(bare.Ingredients) != 0 || len(bare.Units) != 0 || len(bare.Labels) != 0 || len(bare.Files) != 0 {
		t.Errorf("无引用的菜谱不该带出字典行，got %+v", bare)
	}
}

// 私有菜谱与不存在的菜谱在详情上都是同一个 404：不能泄漏「这条 id 存在但不可见」。
func TestGetPublicRecipeOfPrivateReturnsNotVisible(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)
	private := seedRecipe(t, pool, a, nil, false) // is_public 默认 0

	if _, err := community.GetPublicRecipe(ctx, b, private); !errors.Is(err, ErrRecipeNotVisible) {
		t.Fatalf("读私有菜谱详情 err = %v, want ErrRecipeNotVisible", err)
	}
	if _, err := community.GetPublicRecipe(ctx, b, "r-"+uuid.NewString()); !errors.Is(err, ErrRecipeNotVisible) {
		t.Fatalf("读不存在的菜谱详情 err = %v, want ErrRecipeNotVisible", err)
	}
}

// 取消关注幂等：没关注过也能调；关注后调两次行没了，Profile 回到 Followed = false。
func TestUnfollowIsIdempotent(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	a := seedUser(t, pool)
	b := seedUser(t, pool)

	// 从没关注过的用户也能调
	if err := community.Unfollow(ctx, a, uuid.NewString()); err != nil {
		t.Fatalf("取消未关注的用户失败: %v", err)
	}
	if err := community.Unfollow(ctx, a, a); err != nil {
		t.Fatalf("取消关注自己失败: %v", err)
	}

	if err := community.Follow(ctx, a, b); err != nil {
		t.Fatalf("关注失败: %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := community.Unfollow(ctx, a, b); err != nil {
			t.Fatalf("第 %d 次取消关注失败: %v", i+1, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM follows WHERE follower_id = $1 AND followee_id = $2`, a, b).Scan(&n); err != nil {
		t.Fatalf("统计关注失败: %v", err)
	}
	if n != 0 {
		t.Errorf("取消关注后关注行数 = %d, want 0", n)
	}

	p, err := community.Profile(ctx, a, b)
	if err != nil {
		t.Fatalf("读资料失败: %v", err)
	}
	if p.Followed {
		t.Errorf("取消关注后 Profile.Followed = true, want false")
	}
}
