package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

// fakeInviteRedis 实现 inviteRedis，记录 Del 调用以便断言邀请码有没有被消费掉。
type fakeInviteRedis struct {
	getVal  string
	getErr  error
	delKeys []string
}

func (f *fakeInviteRedis) Get(context.Context, string) *redis.StringCmd {
	return redis.NewStringResult(f.getVal, f.getErr)
}

func (f *fakeInviteRedis) Del(_ context.Context, keys ...string) *redis.IntCmd {
	f.delKeys = append(f.delKeys, keys...)
	return redis.NewIntResult(int64(len(keys)), nil)
}

// teamRow 是团队相关测试里的假行：比 auth_test.go 的 fakeRow 多认一个 *int
// （COUNT(*) 扫进 model.Team.MemberCount），且不共享文件、不改动已有测试。
type teamRow struct {
	vals    []any
	scanErr error
}

func (r teamRow) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	for i, v := range r.vals {
		if i >= len(dest) {
			break
		}
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case *bool:
			*d = v.(bool)
		case *time.Time:
			*d = v.(time.Time)
		case *int:
			*d = int(v.(int64))
		}
	}
	return nil
}

// teamRows 是查询结果集的假实现：只覆盖被扫描用到的方法，
// 其余方法由嵌入的 nil pgx.Rows 兜底（真被调用到会 panic，正好暴露意外路径）。
type teamRows struct {
	pgx.Rows
	rows []teamRow
	idx  int
}

func (r *teamRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }

func (r *teamRows) Scan(dest ...any) error { return r.rows[r.idx-1].Scan(dest...) }

func (r *teamRows) Err() error { return nil }

func (r *teamRows) Close() {}

// teamQuerier 在 fakeQuerier 的基础上让 Query 返回预设结果集。
type teamQuerier struct {
	*fakeQuerier
	result *teamRows
}

func (f *teamQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return f.result, nil
}

func newTeamQuerier(result *teamRows) *teamQuerier {
	return &teamQuerier{fakeQuerier: &fakeQuerier{}, result: result}
}

// 建团队只写 teams + team_members(owner) 两行：wee-cook 没有账本抽象（不建 ledgers），
// 也不加同步用的 advisory 写锁（团队不参与同步协议，没有 server_seq 要串行化）。
func TestCreateTeamMakesCreatorOwner(t *testing.T) {
	fq := &fakeQuerier{}

	team, err := insertTeam(context.Background(), fq, "user-1", "My Team")
	if err != nil {
		t.Fatalf("insertTeam: %v", err)
	}
	if team.ID == "" || team.Name != "My Team" || team.CreatedBy != "user-1" {
		t.Fatalf("返回的团队字段不符，got %+v", team)
	}
	if team.MemberCount != 1 {
		t.Errorf("新建团队只有建者一个成员，MemberCount 应为 1，got %d", team.MemberCount)
	}
	if len(fq.execs) != 2 {
		t.Fatalf("建团队应恰好写两行，got %+v", fq.execs)
	}
	if !strings.Contains(fq.execs[0].sql, "INSERT INTO teams") {
		t.Errorf("第一条写库语句应是 INSERT INTO teams，got %s", fq.execs[0].sql)
	}
	if !strings.Contains(fq.execs[1].sql, "INSERT INTO team_members") ||
		!strings.Contains(fq.execs[1].sql, "'owner'") {
		t.Errorf("第二条写库语句应把建者插成 owner，got %s", fq.execs[1].sql)
	}
	if fq.execSQLContains("ledger") {
		t.Errorf("wee-cook 无账本抽象，建团队不应写 ledgers：%+v", fq.execs)
	}
}

func TestCreateInviteRejectsNonOwner(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{teamRow{vals: []any{"owner-1"}}}}

	_, err := (&TeamService{db: fq}).CreateInvite(context.Background(), "user-2", "team-1")
	if !errors.Is(err, ErrNotTeamOwner) {
		t.Fatalf("非 owner 建邀请码应返回 ErrNotTeamOwner，got %v", err)
	}
}

func TestCreateInviteTeamNotFound(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{teamRow{scanErr: pgx.ErrNoRows}}}

	_, err := (&TeamService{db: fq}).CreateInvite(context.Background(), "user-1", "ghost-team")
	if !errors.Is(err, ErrTeamNotFound) {
		t.Fatalf("团队不存在应返回 ErrTeamNotFound，got %v", err)
	}
}

// 已是成员时不应消费邀请码（Del 不被调用），避免白烧码。
func TestJoinByInviteRejectsWhenAlreadyMember(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "team-1:owner-1"}
	fq := &fakeQuerier{rows: []pgx.Row{teamRow{vals: []any{true}}}} // exists=true

	_, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if !errors.Is(err, ErrAlreadyMember) {
		t.Fatalf("应返回 ErrAlreadyMember，got %v", err)
	}
	if len(rd.delKeys) != 0 {
		t.Fatalf("已是成员不应消费邀请码，但 Del 被调用 %d 次，keys=%v", len(rd.delKeys), rd.delKeys)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("已是成员不应写库，got %+v", fq.execs)
	}
}

func TestJoinByInviteExpiredCode(t *testing.T) {
	rd := &fakeInviteRedis{getErr: redis.Nil}
	fq := &fakeQuerier{}

	_, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("邀请码过期应返回 ErrInviteInvalid，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("无效邀请码不应碰库，got %+v", fq.execs)
	}
}

// Redis 里的值没有分隔符（脏数据）时也当失效码处理，不碰库、不报 500。
func TestJoinByInviteMalformedValue(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "garbage"}
	fq := &fakeQuerier{}

	_, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if !errors.Is(err, ErrInviteInvalid) {
		t.Fatalf("邀请码值损坏应返回 ErrInviteInvalid，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("损坏的邀请码不应碰库，got %+v", fq.execs)
	}
}

// 成功加入后才消费邀请码（Del 恰好一次，且 INSERT 在 Del 之前）。
func TestJoinByInviteConsumesCodeOnlyOnSuccess(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "team-1:owner-1"}
	now := time.Now().UTC()
	fq := &fakeQuerier{rows: []pgx.Row{
		teamRow{vals: []any{false}}, // exists=false
		teamRow{vals: []any{"team-1", "My Team", "owner-1", now, now, int64(2)}}, // 加入后的团队（含成员数）
	}}

	resp, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if err != nil {
		t.Fatalf("加入应成功，got %v", err)
	}
	if resp.Team.ID != "team-1" || resp.Team.Name != "My Team" {
		t.Fatalf("应返回加入的团队信息，got %+v", resp.Team)
	}
	if resp.Team.MemberCount != 2 {
		t.Errorf("返回的成员数应含加入者，want 2, got %d", resp.Team.MemberCount)
	}
	if len(rd.delKeys) != 1 || rd.delKeys[0] != "invite:123456" {
		t.Fatalf("成功加入后应恰好消费一次邀请码，keys=%v", rd.delKeys)
	}
	if len(fq.execs) == 0 || !strings.Contains(fq.execs[0].sql, "INSERT INTO team_members") {
		t.Fatalf("应先执行 INSERT 再消费邀请码，execs=%+v", fq.execs)
	}
}

func TestListMembersRejectsNonMember(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{teamRow{vals: []any{false}}}} // isMember=false

	_, err := (&TeamService{db: fq}).ListMembers(context.Background(), "user-1", "team-1")
	if !errors.Is(err, ErrNotTeamMember) {
		t.Fatalf("非成员应返回 ErrNotTeamMember，got %v", err)
	}
}

func TestListMyTeamsReturnsMemberCounts(t *testing.T) {
	now := time.Now().UTC()
	fq := newTeamQuerier(&teamRows{rows: []teamRow{
		{vals: []any{"team-1", "家", "user-1", now, now, int64(3)}},
	}})

	teams, err := (&TeamService{db: fq}).ListMyTeams(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("ListMyTeams: %v", err)
	}
	if len(teams) != 1 {
		t.Fatalf("应返回 1 个团队，got %+v", teams)
	}
	if teams[0].ID != "team-1" || teams[0].Name != "家" || teams[0].MemberCount != 3 {
		t.Fatalf("团队字段不符，got %+v", teams[0])
	}
}

// 一个团队都没有时应返回空列表而不是 nil（JSON 序列化成 [] 而不是 null，前端可直接遍历）。
func TestListMyTeamsEmptyIsEmptySlice(t *testing.T) {
	teams, err := (&TeamService{db: newTeamQuerier(&teamRows{})}).ListMyTeams(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("ListMyTeams: %v", err)
	}
	if teams == nil || len(teams) != 0 {
		t.Fatalf("空列表应是长度为 0 的非 nil 切片，got %#v", teams)
	}
}

func TestMyTeamIDsReturnsJoinedTeamSet(t *testing.T) {
	fq := newTeamQuerier(&teamRows{rows: []teamRow{
		{vals: []any{"team-1"}},
		{vals: []any{"team-2"}},
	}})

	ids, err := myTeamIDs(context.Background(), fq, "user-1")
	if err != nil {
		t.Fatalf("myTeamIDs: %v", err)
	}
	if len(ids) != 2 || !ids["team-1"] || !ids["team-2"] {
		t.Fatalf("应返回用户加入的全部团队 id，got %+v", ids)
	}
}
