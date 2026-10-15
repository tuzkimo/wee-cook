package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-cook/backend/internal/model"
)

// ErrRecipeNotVisible 表示菜谱不存在、未公开或已删除——三种情况对外都是 404（spec §8）。
var ErrRecipeNotVisible = errors.New("recipe not visible")

// ErrSelfFollow 表示试图关注自己，对外是 400（spec §8）。
// 「用户不存在」复用 auth.go 里的 ErrUserNotFound（同包同义），handler 直接 errors.Is 映射 404。
var ErrSelfFollow = errors.New("cannot follow yourself")

// CommunityService 提供社区侧的写操作（收藏 / 关注）与用户资料页（spec §8）。
type CommunityService struct {
	pool *pgxpool.Pool
}

func NewCommunityService(pool *pgxpool.Pool) *CommunityService {
	return &CommunityService{pool: pool}
}

// Favorite 收藏一条公开菜谱。三步必须在同一个事务里：
// 可见性检查与写入之间不留窗口，server_seq 的推进也必须和收藏行一起提交——
// 否则收藏成功而游标没推进，客户端用增量永远拉不到正文。
func (s *CommunityService) Favorite(ctx context.Context, userID, recipeID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin favorite tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 先拿全局同步写锁再碰 recipes 行（与 sync.go 同一个顺序，不会引入新死锁）：
	// Favorite 是第二个 nextval('global_server_seq') 分配者，不排队就会出现
	// 「同步事务领号 100 未提交 → Favorite 领号 101 先提交 → 客户端游标推到 101 →
	// 同步事务提交后 seq=100 被永久跳过」的静默分叉（spec §7.2 / §7.4）。
	if _, err := tx.Exec(ctx, advisoryLockSQL); err != nil {
		return fmt.Errorf("acquire advisory lock: %w", err)
	}

	var one int
	// 取排他锁而不是 FOR SHARE：同一事务随后还要 UPDATE 这一行来推进 server_seq，
	// 共享锁升级时并发收藏彼此互等（40P01）；sync.go 也对同一行取 FOR UPDATE，一起排队才不死锁。
	err = tx.QueryRow(ctx,
		`SELECT 1 FROM recipes WHERE id = $1 AND is_public = 1 AND deleted_at IS NULL FOR UPDATE`,
		recipeID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRecipeNotVisible
	}
	if err != nil {
		return fmt.Errorf("check recipe visible: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO favorites (user_id, recipe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		userID, recipeID); err != nil {
		return fmt.Errorf("insert favorite: %w", err)
	}

	// server_seq 在这里也表示「这条菜谱对某些客户端的可见性 / 订阅状态变了」，不只是「内容变了」（spec §7.4）：
	// 收藏一条 server_seq 早于本机游标的菜谱，靠增量永远拉不下来，所以必须把它推到最新。
	if _, err := tx.Exec(ctx,
		`UPDATE recipes SET server_seq = nextval('global_server_seq') WHERE id = $1`,
		recipeID); err != nil {
		return fmt.Errorf("bump server_seq: %w", err)
	}

	return tx.Commit(ctx)
}

// Unfavorite 只删收藏行，不推进 server_seq：菜谱离开我的可见范围，正文不会再下发，
// 本地靠同步下发的 favorite_recipe_ids 对账消失（spec §7.4）。
func (s *CommunityService) Unfavorite(ctx context.Context, userID, recipeID string) error {
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM favorites WHERE user_id = $1 AND recipe_id = $2`,
		userID, recipeID); err != nil {
		return fmt.Errorf("delete favorite: %w", err)
	}
	return nil
}

// Follow 关注一个用户，幂等：重复关注靠主键冲突吞掉。不能关注自己，目标用户必须存在。
func (s *CommunityService) Follow(ctx context.Context, followerID, followeeID string) error {
	if followerID == followeeID {
		return ErrSelfFollow
	}

	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, followeeID).Scan(&exists); err != nil {
		return fmt.Errorf("check followee exists: %w", err)
	}
	if !exists {
		return ErrUserNotFound
	}

	if _, err := s.pool.Exec(ctx,
		`INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		followerID, followeeID); err != nil {
		return fmt.Errorf("insert follow: %w", err)
	}
	return nil
}

// Unfollow 取消关注，幂等：没关注过也成功。取消关注不校验目标用户是否存在——
// 它只删自己名下的订阅关系，用户删了也一样是「已经没有这层关系」。
func (s *CommunityService) Unfollow(ctx context.Context, followerID, followeeID string) error {
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
		followerID, followeeID); err != nil {
		return fmt.Errorf("delete follow: %w", err)
	}
	return nil
}

// Profile 返回用户资料页视图：昵称、头像、查看者是否已关注，以及 ta 的公开菜谱数。
func (s *CommunityService) Profile(ctx context.Context, viewerID, userID string) (*model.UserProfile, error) {
	p := &model.UserProfile{}
	if err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.nickname, u.avatar_url,
		       EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id)
		FROM users u WHERE u.id = $2`, viewerID, userID).
		Scan(&p.ID, &p.Nickname, &p.AvatarURL, &p.Followed); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("load user profile: %w", err)
	}

	// 只数公开且未删除的：私有的不该出现在外人看得到的资料页上。
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM recipes WHERE owner_id = $1 AND is_public = 1 AND deleted_at IS NULL`,
		userID).Scan(&p.PublicCount); err != nil {
		return nil, fmt.Errorf("count public recipes: %w", err)
	}

	return p, nil
}

// ListPublicRecipes 翻页列出社区里别人的公开菜谱（spec §8）。
// 第二个返回值是 hasMore：靠多取一条算出来，调用方不用再发一次「还有没有下一页」的请求。
func (s *CommunityService) ListPublicRecipes(ctx context.Context, viewerID string, opts model.CommunityListOptions) ([]model.CommunityRecipe, bool, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	offset := max(opts.Offset, 0)

	// $1 固定是 viewer：列表要排除自己的菜谱，LEFT JOIN 的收藏标记也按它取。
	args := []any{viewerID}
	conds := []string{"r.owner_id <> $1", "r.is_public = 1", "r.deleted_at IS NULL"}
	if opts.AuthorID != "" {
		args = append(args, opts.AuthorID)
		conds = append(conds, fmt.Sprintf("r.owner_id = $%d", len(args)))
	}
	if opts.FollowedOnly {
		conds = append(conds, "r.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)")
	}
	args = append(args, limit+1, offset)

	recipes, err := queryList(ctx, s.pool, fmt.Sprintf(
		`SELECT r.id, r.name, r.cover_path, r.owner_id, u.nickname, r.updated_at, (f.user_id IS NOT NULL)
		 FROM recipes r
		 LEFT JOIN users u ON u.id = r.owner_id
		 LEFT JOIN favorites f ON f.recipe_id = r.id AND f.user_id = $1
		 WHERE %s
		 ORDER BY r.updated_at DESC, r.id ASC
		 LIMIT $%d OFFSET $%d`,
		strings.Join(conds, " AND "), len(args)-1, len(args)), args,
		func(rows pgx.Rows) (model.CommunityRecipe, error) {
			var it model.CommunityRecipe
			err := rows.Scan(&it.ID, &it.Name, &it.CoverPath, &it.AuthorID, &it.AuthorNickname, &it.UpdatedAt, &it.Favorited)
			return it, err
		})
	if err != nil {
		return nil, false, fmt.Errorf("list public recipes: %w", err)
	}

	// 多取的那一条只用来判断 hasMore，不返回给客户端。
	hasMore := len(recipes) > limit
	if hasMore {
		recipes = recipes[:limit]
	}
	return recipes, hasMore, nil
}

// GetPublicRecipe 返回一条公开菜谱的完整载荷，形状与 /sync 的 remote_changes 一致：
// 子行、引用到的字典行、图片清单都在里面，客户端可以直接喂给现有的落库逻辑。
// 不存在、未公开、已删除对外都是同一个 ErrRecipeNotVisible（spec §8）。
func (s *CommunityService) GetPublicRecipe(ctx context.Context, viewerID, recipeID string) (*model.SyncPayload, error) {
	// viewerID 不参与查询：公开条件只有「公开且未删」，详情不排除自己的公开菜谱
	// （排除自己只是列表的规矩），保留参数是为了与 ListPublicRecipes 的签名对称。
	recipes, err := queryList(ctx, s.pool,
		`SELECT `+recipeSelectColumns+`
		 FROM recipes r LEFT JOIN users u ON u.id = r.owner_id
		 WHERE r.id = $1 AND r.is_public = 1 AND r.deleted_at IS NULL`,
		[]any{recipeID}, scanRecipeRow)
	if err != nil {
		return nil, fmt.Errorf("query public recipe: %w", err)
	}
	if len(recipes) == 0 {
		return nil, ErrRecipeNotVisible
	}
	if recipes, err = attachRecipeChildren(ctx, s.pool, recipes); err != nil {
		return nil, fmt.Errorf("attach recipe children: %w", err)
	}

	// 三个字典数组给空切片而不是 nil：客户端拿这份载荷直接落库，JSON 里的 [] 与 null 不同。
	payload := model.SyncPayload{
		Ingredients: []model.Ingredient{},
		Units:       []model.Unit{},
		Labels:      []model.Label{},
		Recipes:     recipes,
		Files:       []model.FileRef{},
	}
	// 增量同步不会带上「菜谱引用到但 server_seq 很老」的字典行，详情必须补齐，否则客户端缺外键行。
	if err := backfillReferenced(ctx, s.pool, &payload); err != nil {
		return nil, fmt.Errorf("backfill referenced: %w", err)
	}
	if payload.Files, err = queryFiles(ctx, s.pool, payload.Recipes); err != nil {
		return nil, fmt.Errorf("query files: %w", err)
	}
	return &payload, nil
}
