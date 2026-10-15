package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrRecipeNotVisible 表示菜谱不存在、未公开或已删除——三种情况对外都是 404（spec §8）。
var ErrRecipeNotVisible = errors.New("recipe not visible")

// CommunityService 提供社区侧的两个写操作：收藏与取消收藏（spec §8）。
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

	var one int
	err = tx.QueryRow(ctx,
		`SELECT 1 FROM recipes WHERE id = $1 AND is_public = 1 AND deleted_at IS NULL FOR SHARE`,
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
