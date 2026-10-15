// 收藏 / 取消收藏的真库集成测试：复用 files_test.go 的容器与 seed 辅助、sync_integration_test.go 的同步辅助。
// 这组用例覆盖 spec §7.4 那条只有真 SQL 才验得出的规矩——收藏要把菜谱的 server_seq 推到最新，
// 否则游标已经推过它的客户端靠增量永远拉不到正文。
package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

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
