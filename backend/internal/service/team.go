package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 团队 = 家庭（spec §9）。团队只走 REST、不进同步载荷：它是「我的身份」，不是内容。
// 角色只有 owner / member，一个团队恰好一个 owner。
var (
	ErrTeamNotFound      = errors.New("team not found")
	ErrNotTeamOwner      = errors.New("not team owner")
	ErrNotTeamMember     = errors.New("not team member")
	ErrInviteInvalid     = errors.New("invite code invalid or expired")
	ErrOwnerCannotLeave  = errors.New("owner must transfer or dissolve first")
	ErrCannotRemoveOwner = errors.New("cannot remove the owner; use leave or transfer")
	ErrNotMemberTarget   = errors.New("target user is not a member of this team")
)

const (
	inviteCodeTTL  = 24 * time.Hour
	inviteCodeLen  = 6
	inviteKeyStart = "invite:"
	roleOwner      = "owner"
	roleMember     = "member"
)

// TeamSummary 是「我加入的团队」的一行：列表与建团 / 入组的返回值同形状。
type TeamSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	MemberCount int    `json:"member_count"`
}

// TeamMember 是成员列表的一行。
type TeamMember struct {
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

// inviteRedis 是邀请码存储的窄接口：生产传 *redis.Client 的适配器，测试注入内存实现。
type inviteRedis interface {
	Get(ctx context.Context, key string) (value string, ok bool, err error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	Del(ctx context.Context, key string) error
}

type TeamService struct {
	pool *pgxpool.Pool
	kv   inviteRedis
}

func NewTeamService(pool *pgxpool.Pool, kv inviteRedis) *TeamService {
	return &TeamService{pool: pool, kv: kv}
}

// List 是我加入的、未解散的团队 + 成员数 + 我的角色。
func (s *TeamService) List(ctx context.Context, userID string) ([]TeamSummary, error) {
	return queryList(ctx, s.pool,
		`SELECT t.id::text, t.name, tm.role,
		        (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)
		 FROM team_members tm JOIN teams t ON t.id = tm.team_id
		 WHERE tm.user_id = $1 AND t.deleted_at IS NULL
		 ORDER BY t.name, t.id`,
		[]any{userID}, func(rows pgx.Rows) (TeamSummary, error) {
			var it TeamSummary
			err := rows.Scan(&it.ID, &it.Name, &it.Role, &it.MemberCount)
			return it, err
		})
}

// Create 建团：写 teams + owner 成员两行，建者即 owner。
func (s *TeamService) Create(ctx context.Context, userID, name string) (TeamSummary, error) {
	var id string
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id::text`,
		name, userID).Scan(&id); err != nil {
		return TeamSummary{}, fmt.Errorf("insert team: %w", err)
	}
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, id, userID, roleOwner); err != nil {
		return TeamSummary{}, fmt.Errorf("insert team owner: %w", err)
	}
	return TeamSummary{ID: id, Name: name, Role: roleOwner, MemberCount: 1}, nil
}

// Invite 生成 6 位码：Redis 里存 teamID:creatorID，24h 过期（spec §9）。
func (s *TeamService) Invite(ctx context.Context, userID, teamID string) (string, error) {
	if err := s.requireOwner(ctx, teamID, userID); err != nil {
		return "", err
	}
	code, err := randomCode()
	if err != nil {
		return "", err
	}
	if err := s.kv.Set(ctx, inviteKeyStart+code, teamID+":"+userID, inviteCodeTTL); err != nil {
		return "", fmt.Errorf("store invite: %w", err)
	}
	return code, nil
}

// Join 用邀请码入组：码有效且团队未解散才写成员行，写入成功后再删码（失败可重试）。
func (s *TeamService) Join(ctx context.Context, userID, code string) (TeamSummary, error) {
	value, ok, err := s.kv.Get(ctx, inviteKeyStart+code)
	if err != nil {
		return TeamSummary{}, fmt.Errorf("read invite: %w", err)
	}
	if !ok {
		return TeamSummary{}, ErrInviteInvalid
	}
	teamID, _, _ := strings.Cut(value, ":")
	if !s.teamAlive(ctx, teamID) {
		return TeamSummary{}, ErrInviteInvalid
	}
	// ON CONFLICT DO NOTHING：重复入组不插第二行，也不把 owner 降级成 member。
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO NOTHING`,
		teamID, userID, roleMember); err != nil {
		return TeamSummary{}, fmt.Errorf("insert member: %w", err)
	}
	if err := s.kv.Del(ctx, inviteKeyStart+code); err != nil {
		return TeamSummary{}, fmt.Errorf("consume invite: %w", err)
	}
	return s.summary(ctx, teamID, userID)
}

// Rename 改名（owner）。
func (s *TeamService) Rename(ctx context.Context, userID, teamID, name string) error {
	if err := s.requireOwner(ctx, teamID, userID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2`, name, teamID)
	return err
}

// Members 是成员列表（成员可见）。
func (s *TeamService) Members(ctx context.Context, userID, teamID string) ([]TeamMember, error) {
	if err := s.requireMember(ctx, teamID, userID); err != nil {
		return nil, err
	}
	return queryList(ctx, s.pool,
		`SELECT u.id::text, u.nickname, u.username, tm.role
		 FROM team_members tm JOIN users u ON u.id = tm.user_id
		 WHERE tm.team_id = $1
		 ORDER BY tm.joined_at, u.id`,
		[]any{teamID}, func(rows pgx.Rows) (TeamMember, error) {
			var it TeamMember
			err := rows.Scan(&it.UserID, &it.Nickname, &it.Username, &it.Role)
			return it, err
		})
}

// RemoveMember 移除成员（owner；不能移除自己——那是退出）。
func (s *TeamService) RemoveMember(ctx context.Context, userID, teamID, targetID string) error {
	if err := s.requireOwner(ctx, teamID, userID); err != nil {
		return err
	}
	if targetID == userID {
		return ErrCannotRemoveOwner
	}
	role, err := s.targetRole(ctx, teamID, targetID)
	if err != nil {
		return err
	}
	if role == roleOwner {
		return ErrCannotRemoveOwner
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, targetID)
	return err
}

// Leave 退出（owner 必须先转让或解散）。
func (s *TeamService) Leave(ctx context.Context, userID, teamID string) error {
	role, err := s.roleOf(ctx, teamID, userID)
	if err != nil {
		return err
	}
	if role == roleOwner {
		return ErrOwnerCannotLeave
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, userID)
	return err
}

// Transfer 转让 owner：事务内两条 UPDATE，任何一条失败都不会留下「两个 owner」。
func (s *TeamService) Transfer(ctx context.Context, userID, teamID, targetID string) error {
	if err := s.requireOwner(ctx, teamID, userID); err != nil {
		return err
	}
	if targetID == userID {
		return ErrNotMemberTarget
	}
	if _, err := s.targetRole(ctx, teamID, targetID); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`, roleOwner, teamID, targetID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`, roleMember, teamID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE teams SET updated_at = NOW() WHERE id = $1`, teamID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Dissolve 解散：只软删 teams 行，成员行与团队数据都留着（可见范围 SQL 已按 deleted_at 过滤）。
func (s *TeamService) Dissolve(ctx context.Context, userID, teamID string) error {
	if err := s.requireOwner(ctx, teamID, userID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE teams SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, teamID)
	return err
}

// --- 内部辅助 ---

func (s *TeamService) teamAlive(ctx context.Context, teamID string) bool {
	var ok bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM teams WHERE id = $1 AND deleted_at IS NULL)`, teamID).Scan(&ok); err != nil {
		return false
	}
	return ok
}

// roleOf 返回我在该团队的角色（团队不存在 → ErrTeamNotFound，不是成员 → ErrNotTeamMember）。
func (s *TeamService) roleOf(ctx context.Context, teamID, userID string) (string, error) {
	if !s.teamAlive(ctx, teamID) {
		return "", ErrTeamNotFound
	}
	var role string
	err := s.pool.QueryRow(ctx,
		`SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotTeamMember
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

// targetRole 是「别人在这个团队里的角色」：目标不是成员 → ErrNotMemberTarget（与「我不是成员」区分开）。
func (s *TeamService) targetRole(ctx context.Context, teamID, targetID string) (string, error) {
	role, err := s.roleOf(ctx, teamID, targetID)
	if errors.Is(err, ErrNotTeamMember) {
		return "", ErrNotMemberTarget
	}
	return role, err
}

func (s *TeamService) requireMember(ctx context.Context, teamID, userID string) error {
	_, err := s.roleOf(ctx, teamID, userID)
	return err
}

func (s *TeamService) requireOwner(ctx context.Context, teamID, userID string) error {
	role, err := s.roleOf(ctx, teamID, userID)
	if err != nil {
		return err
	}
	if role != roleOwner {
		return ErrNotTeamOwner
	}
	return nil
}

// summary 拼一条「我在该团队」的 TeamSummary。
func (s *TeamService) summary(ctx context.Context, teamID, userID string) (TeamSummary, error) {
	var it TeamSummary
	err := s.pool.QueryRow(ctx,
		`SELECT t.id::text, t.name, tm.role,
		        (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)
		 FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
		 WHERE t.id = $1 AND t.deleted_at IS NULL`, teamID, userID).
		Scan(&it.ID, &it.Name, &it.Role, &it.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return TeamSummary{}, ErrNotTeamMember
	}
	return it, err
}

// randomCode 生成 6 位数字码：crypto/rand 而不是 math/rand——邀请码就是入组凭据。
func randomCode() (string, error) {
	digitRange := big.NewInt(10)
	digits := make([]byte, inviteCodeLen)
	for i := range digits {
		n, err := rand.Int(rand.Reader, digitRange)
		if err != nil {
			return "", fmt.Errorf("random code: %w", err)
		}
		digits[i] = byte('0' + n.Int64())
	}
	return string(digits), nil
}
