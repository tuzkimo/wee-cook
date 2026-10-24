package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// fakeInviteRedis 是邀请码存储的内存版：只管 6 位码 → 团队，够验 TTL 语义之外的逻辑。
type fakeInviteRedis struct {
	data map[string]string
	ttl  map[string]time.Duration
}

func newFakeInviteRedis() *fakeInviteRedis {
	return &fakeInviteRedis{data: map[string]string{}, ttl: map[string]time.Duration{}}
}

func (f *fakeInviteRedis) Get(_ context.Context, key string) (string, bool, error) {
	v, ok := f.data[key]
	return v, ok, nil
}

func (f *fakeInviteRedis) Set(_ context.Context, key, value string, ttl time.Duration) error {
	f.data[key] = value
	f.ttl[key] = ttl
	return nil
}

func (f *fakeInviteRedis) Del(_ context.Context, key string) error {
	delete(f.data, key)
	delete(f.ttl, key)
	return nil
}

func newTeamService(t *testing.T) (*TeamService, *pgxpool.Pool, *fakeInviteRedis) {
	t.Helper()
	pool := filesTestDB(t)
	rdb := newFakeInviteRedis()
	return NewTeamService(pool, rdb), pool, rdb
}

func mustCreateTeam(t *testing.T, svc *TeamService, userID, name string) TeamSummary {
	t.Helper()
	team, err := svc.Create(context.Background(), userID, name)
	if err != nil {
		t.Fatalf("建团队失败: %v", err)
	}
	return team
}

// 建团写两行：teams + owner 成员；列表按人返回自己的团队与角色。
func TestTeamCreateAndList(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	if team.Role != "owner" || team.MemberCount != 1 {
		t.Errorf("建团后应是 owner / 1 人，got %+v", team)
	}

	teams, err := svc.List(ctx, a)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(teams) != 1 || teams[0].ID != team.ID || teams[0].Name != "自己家" {
		t.Errorf("List = %+v, want 只有「自己家」", teams)
	}
}

// 邀请码 24h、入组成功才删码；第二次加入不重复插成员。
func TestTeamInviteAndJoin(t *testing.T) {
	svc, pool, rdb := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, err := svc.Invite(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if len(code) != 6 {
		t.Errorf("邀请码应是 6 位，got %q", code)
	}
	if ttl := rdb.ttl["invite:"+code]; ttl != 24*time.Hour {
		t.Errorf("邀请码 TTL = %v, want 24h", ttl)
	}

	joined, err := svc.Join(ctx, b, code)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if joined.ID != team.ID || joined.Role != "member" || joined.MemberCount != 2 {
		t.Errorf("入组结果 = %+v, want 自己家的 member / 2 人", joined)
	}
	if _, ok := rdb.data["invite:"+code]; ok {
		t.Error("入组成功后应删掉邀请码")
	}

	// 再入一次（用同一团队的新码）：成员表不重复插
	code2, err := svc.Invite(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Invite(2): %v", err)
	}
	if _, err := svc.Join(ctx, b, code2); err != nil {
		t.Fatalf("Join(2): %v", err)
	}
	members, err := svc.Members(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if len(members) != 2 {
		t.Errorf("成员数 = %d, want 2（重复入组不该插两行）", len(members))
	}
}

func TestTeamJoinInvalidCode(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	b := seedUser(t, pool)

	if _, err := svc.Join(context.Background(), b, "000000"); !errors.Is(err, ErrInviteInvalid) {
		t.Errorf("无效邀请码应返回 ErrInviteInvalid, got %v", err)
	}
}

// 解散的团队不能再入组（可见范围按 deleted_at IS NULL 过滤）。
func TestTeamJoinDissolvedTeamFails(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, err := svc.Invite(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if err := svc.Dissolve(ctx, a, team.ID); err != nil {
		t.Fatalf("Dissolve: %v", err)
	}
	if _, err := svc.Join(ctx, b, code); !errors.Is(err, ErrInviteInvalid) {
		t.Errorf("解散团队的邀请码应失效, got %v", err)
	}
}

// owner 专属操作：非 owner 一律 ErrNotTeamOwner。
func TestTeamOwnerOnlyOperations(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, err := svc.Invite(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if _, err := svc.Join(ctx, b, code); err != nil {
		t.Fatalf("Join: %v", err)
	}

	cases := []struct {
		name string
		call func() error
	}{
		{"改名", func() error { return svc.Rename(ctx, b, team.ID, "改名") }},
		{"邀请", func() error { _, err := svc.Invite(ctx, b, team.ID); return err }},
		{"移除", func() error { return svc.RemoveMember(ctx, b, team.ID, a) }},
		{"转让", func() error { return svc.Transfer(ctx, b, team.ID, b) }},
		{"解散", func() error { return svc.Dissolve(ctx, b, team.ID) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := c.call(); !errors.Is(err, ErrNotTeamOwner) {
				t.Errorf("%s 应返回 ErrNotTeamOwner, got %v", c.name, err)
			}
		})
	}
}

// owner 退出前必须转让或解散；member 可以自己退。
func TestTeamLeaveRules(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, _ := svc.Invite(ctx, a, team.ID)
	if _, err := svc.Join(ctx, b, code); err != nil {
		t.Fatalf("Join: %v", err)
	}

	if err := svc.Leave(ctx, a, team.ID); !errors.Is(err, ErrOwnerCannotLeave) {
		t.Errorf("owner 直接退出应返回 ErrOwnerCannotLeave, got %v", err)
	}
	if err := svc.Leave(ctx, b, team.ID); err != nil {
		t.Fatalf("member 退组失败: %v", err)
	}
	members, err := svc.Members(ctx, a, team.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	if len(members) != 1 {
		t.Errorf("退组后成员数 = %d, want 1", len(members))
	}
}

// 移除规则：不能移除自己（那是退出）、目标必须是成员。
func TestTeamRemoveMemberRules(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)
	c := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, _ := svc.Invite(ctx, a, team.ID)
	if _, err := svc.Join(ctx, b, code); err != nil {
		t.Fatalf("Join: %v", err)
	}

	if err := svc.RemoveMember(ctx, a, team.ID, a); !errors.Is(err, ErrCannotRemoveOwner) {
		t.Errorf("移除自己应返回 ErrCannotRemoveOwner, got %v", err)
	}
	if err := svc.RemoveMember(ctx, a, team.ID, c); !errors.Is(err, ErrNotMemberTarget) {
		t.Errorf("移除不在团队里的人应返回 ErrNotMemberTarget, got %v", err)
	}
	if err := svc.RemoveMember(ctx, a, team.ID, b); err != nil {
		t.Fatalf("移除成员失败: %v", err)
	}
}

// 转让：原 owner 变 member、目标变 owner；转让后原 owner 才能退出。
func TestTeamTransferOwner(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	code, _ := svc.Invite(ctx, a, team.ID)
	if _, err := svc.Join(ctx, b, code); err != nil {
		t.Fatalf("Join: %v", err)
	}

	if err := svc.Transfer(ctx, a, team.ID, b); err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	members, err := svc.Members(ctx, b, team.ID)
	if err != nil {
		t.Fatalf("Members: %v", err)
	}
	roles := map[string]string{}
	for _, m := range members {
		roles[m.UserID] = m.Role
	}
	if roles[a] != "member" || roles[b] != "owner" {
		t.Errorf("转让后角色 = %+v, want A=member B=owner", roles)
	}
	if err := svc.Leave(ctx, a, team.ID); err != nil {
		t.Errorf("转让后原 owner 应能退出: %v", err)
	}
}

// 解散后 List 不再返回它，成员也读不到成员列表。
func TestTeamDissolveHidesIt(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	if err := svc.Dissolve(ctx, a, team.ID); err != nil {
		t.Fatalf("Dissolve: %v", err)
	}
	teams, err := svc.List(ctx, a)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(teams) != 0 {
		t.Errorf("解散后 List 不该再返回它，got %+v", teams)
	}
	if _, err := svc.Members(ctx, a, team.ID); !errors.Is(err, ErrTeamNotFound) {
		t.Errorf("解散团队的成员列表应返回 ErrTeamNotFound, got %v", err)
	}
}

// 非成员读成员列表：403（ErrNotTeamMember），不是 404——团队存在，只是不归他。
func TestTeamMembersRequiresMembership(t *testing.T) {
	svc, pool, _ := newTeamService(t)
	ctx := context.Background()
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	team := mustCreateTeam(t, svc, a, "自己家")
	if _, err := svc.Members(ctx, b, team.ID); !errors.Is(err, ErrNotTeamMember) {
		t.Errorf("非成员读成员列表应返回 ErrNotTeamMember, got %v", err)
	}
	if err := svc.Rename(ctx, a, team.ID, "爸妈家"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	teams, err := svc.List(ctx, a)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(teams) != 1 || teams[0].Name != "爸妈家" {
		t.Errorf("改名后 List = %+v", teams)
	}
}
