package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"wee-cook/backend/internal/model"
)

var (
	ErrTeamNotFound  = errors.New("team not found")
	ErrNotTeamOwner  = errors.New("only team owner can create invite")
	ErrInviteInvalid = errors.New("invalid or expired invite code")
	ErrAlreadyMember = errors.New("already a member of this team")
)

// inviteRedis 是邀请码通道所需的最小 redis 接口：生产传 *redis.Client，
// 测试注入 fake，以便断言 Del 是否被调用（码有没有被白白烧掉）。
type inviteRedis interface {
	Get(ctx context.Context, key string) *redis.StringCmd
	Del(ctx context.Context, keys ...string) *redis.IntCmd
}

type TeamService struct {
	pool  *pgxpool.Pool // 只有 CreateTeam 的事务需要 Begin
	db    dbQuerier     // 其余查询；生产与 pool 是同一个连接池
	redis *redis.Client
}

func NewTeamService(pool *pgxpool.Pool, redis *redis.Client) *TeamService {
	return &TeamService{pool: pool, db: pool, redis: redis}
}

type CreateTeamResponse struct {
	Team model.Team `json:"team"`
}

func (s *TeamService) CreateTeam(ctx context.Context, userID, name string) (*CreateTeamResponse, error) {
	// 两行必须一起成功：只有 teams 行没有 owner 成员行的团队谁也进不去。
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	team, err := insertTeam(ctx, tx, userID, name)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}
	return &CreateTeamResponse{Team: *team}, nil
}

// insertTeam 写 teams + team_members 两行（抽成自由函数以便注入 fake dbQuerier 测试）。
// 这里不取 syncWriteLockID 那把写锁：团队表没有 server_seq、也不进同步增量通道，
// 锁对它没有任何串行化作用，只会把建团队排在所有同步写事务后面。
func insertTeam(ctx context.Context, q dbQuerier, userID, name string) (*model.Team, error) {
	now := time.Now().UTC()
	team := model.Team{
		ID:          uuid.New().String(),
		Name:        name,
		CreatedBy:   userID,
		CreatedAt:   now,
		UpdatedAt:   now,
		MemberCount: 1, // 建者自己是目前唯一的成员
	}

	if _, err := q.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
		team.ID, name, userID, now, now,
	); err != nil {
		return nil, fmt.Errorf("insert team: %w", err)
	}

	if _, err := q.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
		team.ID, userID, now,
	); err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	return &team, nil
}

func (s *TeamService) CreateInvite(ctx context.Context, userID, teamID string) (string, error) {
	// teams.id 是 UUID 列：非 UUID 原样进 SQL 会撞 SQLSTATE 22P02 变成 500，
	// 这里提前当「团队不存在」处理，与真正的 404 走同一条映射。
	if _, err := uuid.Parse(teamID); err != nil {
		return "", ErrTeamNotFound
	}

	// 只有 owner 能发邀请码：团队管理（改名/解散/移人）不在本轮，owner 是唯一的管理者
	var createdBy string
	err := s.db.QueryRow(ctx, "SELECT created_by FROM teams WHERE id = $1", teamID).Scan(&createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrTeamNotFound
	}
	if err != nil {
		return "", fmt.Errorf("query team: %w", err)
	}
	if createdBy != userID {
		return "", ErrNotTeamOwner
	}

	code, err := generateInviteCode()
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}

	// 值里带发码人，便于排查「这个码是谁发的」；加入时只用得到 teamID
	val := fmt.Sprintf("%s:%s", teamID, userID)
	if err := s.redis.Set(ctx, inviteKey(code), val, 24*time.Hour).Err(); err != nil {
		return "", fmt.Errorf("redis set: %w", err)
	}

	return code, nil
}

func (s *TeamService) JoinByInvite(ctx context.Context, userID, code string) (*CreateTeamResponse, error) {
	return joinByInvite(ctx, s.db, s.redis, userID, code)
}

func joinByInvite(ctx context.Context, q dbQuerier, redisClient inviteRedis, userID, code string) (*CreateTeamResponse, error) {
	key := inviteKey(code)
	val, err := redisClient.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, ErrInviteInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("redis get: %w", err)
	}

	teamID, _, ok := strings.Cut(val, ":")
	if !ok {
		return nil, ErrInviteInvalid
	}

	// 先校验成员资格（未消费邀请码）
	var exists bool
	err = q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)", teamID, userID,
	).Scan(&exists)
	if err != nil {
		return nil, fmt.Errorf("check membership: %w", err)
	}
	if exists {
		return nil, ErrAlreadyMember
	}

	now := time.Now().UTC()
	if _, err := q.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`,
		teamID, userID, now,
	); err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// 一次性消费：仅在成功加入后删除，避免重复加入或 DB 失败白白烧码
	redisClient.Del(ctx, key)

	// 返回加入后的团队（含成员数），客户端可直接替换本地列表里的那一条
	var team model.Team
	err = q.QueryRow(ctx,
		`SELECT t.id, t.name, t.created_by, t.created_at, t.updated_at,
		        (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id)
		 FROM teams t WHERE t.id = $1`, teamID,
	).Scan(&team.ID, &team.Name, &team.CreatedBy, &team.CreatedAt, &team.UpdatedAt, &team.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		// 码指向的团队已不存在：码已经没有意义，和失效码同一处理
		return nil, ErrInviteInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("query team: %w", err)
	}

	return &CreateTeamResponse{Team: team}, nil
}

func inviteKey(code string) string { return "invite:" + code }

func generateInviteCode() (string, error) {
	// 6 位码只有 10^6 种，靠 join 的按 IP 限流压制爆破（见 router.go）
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *TeamService) ListMyTeams(ctx context.Context, userID string) ([]model.Team, error) {
	rows, err := s.db.Query(ctx,
		`SELECT t.id, t.name, t.created_by, t.created_at, t.updated_at,
		        (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id)
		 FROM teams t
		 JOIN team_members tm ON tm.team_id = t.id
		 WHERE tm.user_id = $1
		 ORDER BY tm.joined_at ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("query my teams: %w", err)
	}
	defer rows.Close()

	teams := []model.Team{} // 空列表序列化成 [] 而不是 null，前端可直接遍历
	for rows.Next() {
		var t model.Team
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.MemberCount); err != nil {
			return nil, fmt.Errorf("scan team: %w", err)
		}
		teams = append(teams, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate teams: %w", err)
	}
	return teams, nil
}

func (s *TeamService) ListMembers(ctx context.Context, userID, teamID string) ([]model.TeamMember, error) {
	// team_members.team_id 是 UUID 列：非 UUID 直接当「不是成员」（403），
	// 否则会撞 SQLSTATE 22P02 变成 500。
	if _, err := uuid.Parse(teamID); err != nil {
		return nil, ErrNotTeamMember
	}

	// 越权防护：仅团队成员可查看成员列表
	if err := canReadTeam(ctx, s.db, userID, teamID); err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx,
		`SELECT u.id, u.username, u.nickname, u.avatar_url, tm.role, tm.joined_at
		 FROM team_members tm
		 JOIN users u ON tm.user_id = u.id
		 WHERE tm.team_id = $1
		 ORDER BY tm.joined_at ASC`, teamID)
	if err != nil {
		return nil, fmt.Errorf("query team members: %w", err)
	}
	defer rows.Close()

	members := []model.TeamMember{}
	for rows.Next() {
		var m model.TeamMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.Nickname, &m.AvatarURL, &m.Role, &m.JoinedAt); err != nil {
			return nil, fmt.Errorf("scan team member: %w", err)
		}
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate team members: %w", err)
	}
	return members, nil
}
