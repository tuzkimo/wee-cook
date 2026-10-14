package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// queryCall 记录一次 QueryRow 的 SQL 与参数。fakeQuerier（auth_test.go）只记 Exec，
// 而「同名合并不许筛 deleted_at」「labels 的合并键含 kind」这类断言只能看查询语句。
type queryCall struct {
	sql  string
	args []any
}

// syncQuerier 在 fakeQuerier 之上补一个 QueryRow 记录器，不动已有 fake。
type syncQuerier struct {
	*fakeQuerier
	queries []queryCall
}

func (f *syncQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	f.queries = append(f.queries, queryCall{sql: sql, args: args})
	return f.fakeQuerier.QueryRow(ctx, sql, args...)
}

func newSyncQuerier(rows ...pgx.Row) *syncQuerier {
	return &syncQuerier{fakeQuerier: &fakeQuerier{rows: rows}}
}

// 三张表都没有同名唯一约束：插入前必须按键查过，同一批里重复推同一格也不会撞约束。
func TestMergeDictInsertsWhenAbsent(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier()

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, ingredientSpec,
		dictEntity{ID: "i-new", Name: "盐", CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "i-new" {
		t.Errorf("没有同键行时应返回自身 id，got %q", id)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "INSERT INTO ingredients") {
		t.Fatalf("恰好应写一条 INSERT INTO ingredients，got %+v", q.execs)
	}
	if got := q.execs[0].args[0]; got != "i-new" {
		t.Errorf("INSERT 的第一个参数应是自身 id，got %v", got)
	}
}

// LWW：incoming 不比 remote 新就不动库（相等也应跳过，条件用 After 而非 Before）。
func TestMergeDictSkipsOlder(t *testing.T) {
	remote := time.Now().UTC()
	for _, tc := range []struct {
		name     string
		incoming time.Time
	}{
		{"更旧", remote.Add(-time.Minute)},
		{"相同", remote},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := newSyncQuerier(fakeRow{vals: []any{remote}})

			id, err := NewSyncService(nil).mergeDict(context.Background(), q, unitSpec,
				dictEntity{ID: "u-1", Name: "克", UpdatedAt: tc.incoming})
			if err != nil {
				t.Fatalf("mergeDict: %v", err)
			}
			if id != "u-1" {
				t.Errorf("跳过时也应返回自身 id，got %q", id)
			}
			if len(q.execs) != 0 {
				t.Fatalf("incoming 不比 remote 新就不该 UPDATE，got %+v", q.execs)
			}
			if !strings.Contains(q.queries[0].sql, "FOR UPDATE") {
				t.Errorf("按主键查 updated_at 要 FOR UPDATE 锁行，got %s", q.queries[0].sql)
			}
		})
	}
}

// 主键查不到、但同名行 id=Y 存在 → 内容并进 Y、丢弃 X，返回有效 id Y（spec §7.4）。
func TestMergeDictMergesByNameIntoExistingID(t *testing.T) {
	old := time.Now().UTC().Add(-time.Hour)
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows}, // 主键 X 不存在
		fakeRow{vals: []any{"Y", old}},  // 同名行 id=Y
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, ingredientSpec,
		dictEntity{ID: "X", Name: "五花肉", UpdatedAt: old.Add(time.Minute)})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "Y" {
		t.Fatalf("同名行应合并到旧 id Y，got %q", id)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "UPDATE ingredients") {
		t.Fatalf("应恰好 UPDATE 旧行一次，got %+v", q.execs)
	}
	if got := q.execs[0].args[len(q.execs[0].args)-1]; got != "Y" {
		t.Errorf("UPDATE 应落在旧 id Y 上，got %v", got)
	}
	keyQuery := q.queries[1]
	if !strings.Contains(keyQuery.sql, "name = $1") {
		t.Errorf("按键查要用 name，got %s", keyQuery.sql)
	}
}

// 软删的同名行仍占着「同名」这个坑：漏判会写出第二条同名数据，两端从此各看各的。
// incoming 未删（DeletedAt=nil）→ 命中后 UPDATE 复活旧行，绝不 INSERT。
func TestMergeDictMatchesSoftDeletedRow(t *testing.T) {
	deleted := time.Now().UTC().Add(-time.Hour)
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows},
		fakeRow{vals: []any{"Y", deleted}}, // 该行的 deleted_at 非空（fake 只回 id/updated_at）
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, unitSpec,
		dictEntity{ID: "X", Name: "克", UpdatedAt: deleted.Add(time.Minute)})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "Y" {
		t.Fatalf("软删的同名行也要命中并返回旧 id Y，got %q", id)
	}
	if strings.Contains(q.queries[1].sql, "deleted_at") {
		t.Fatalf("按键查不得筛 deleted_at，否则会漏判软删行并插出第二条同名数据：%s", q.queries[1].sql)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "UPDATE units") {
		t.Fatalf("应 UPDATE 旧行复活，而不是 INSERT，got %+v", q.execs)
	}
	if got, ok := q.execs[0].args[2].(*time.Time); !ok || got != nil {
		t.Errorf("复活即把 deleted_at 写回 NULL，got %v", got)
	}
}

// labels 的合并键是 (name, kind)：同名不同 kind 是两种东西，合并会让菜谱的分类变成标签。
func TestMergeDictLabelKeyIncludesKind(t *testing.T) {
	now := time.Now().UTC()
	q := newSyncQuerier(
		fakeRow{scanErr: pgx.ErrNoRows}, // 主键不存在
		fakeRow{scanErr: pgx.ErrNoRows}, // 同名同 kind 的行不存在（同名但 kind 不同 → 不命中）
	)

	id, err := NewSyncService(nil).mergeDict(context.Background(), q, labelSpec,
		dictEntity{ID: "L1", Name: "川菜", Kind: "tag", UpdatedAt: now})
	if err != nil {
		t.Fatalf("mergeDict: %v", err)
	}
	if id != "L1" {
		t.Fatalf("kind 不同不该合并，应返回自身 id，got %q", id)
	}
	keyQuery := q.queries[1]
	if !strings.Contains(keyQuery.sql, "name = $1 AND kind = $2") {
		t.Fatalf("labels 的合并键要含 kind，got %s", keyQuery.sql)
	}
	if len(keyQuery.args) != 2 || keyQuery.args[1] != "tag" {
		t.Fatalf("按键查要带上 kind 参数，got %+v", keyQuery.args)
	}
	if len(q.execs) != 1 || !strings.Contains(q.execs[0].sql, "INSERT INTO labels") {
		t.Fatalf("应 INSERT 自身这条，got %+v", q.execs)
	}
	if got := q.execs[0].args[2]; got != "tag" {
		t.Errorf("INSERT 要落 kind 列，got %v", got)
	}
}

// mergeByKey 是 Task 5 菜谱合并的公共骨架，三个分支各钉一次（含 FOR UPDATE）。
func TestMergeByKeyLWW(t *testing.T) {
	remote := time.Now().UTC()
	for _, tc := range []struct {
		name       string
		row        pgx.Row
		incoming   time.Time
		wantInsert bool
		wantUpdate bool
	}{
		{"主键不存在则插入", fakeRow{scanErr: pgx.ErrNoRows}, remote, true, false},
		{"incoming 更旧则跳过", fakeRow{vals: []any{remote}}, remote.Add(-time.Minute), false, false},
		{"incoming 相同则跳过", fakeRow{vals: []any{remote}}, remote, false, false},
		{"incoming 更新则覆盖", fakeRow{vals: []any{remote}}, remote.Add(time.Minute), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := newSyncQuerier(tc.row)
			var inserted, updated bool
			err := mergeByKey(context.Background(), q, tc.incoming,
				"SELECT updated_at FROM recipes WHERE id = $1", []any{"r-1"},
				func() error { inserted = true; return nil },
				func() error { updated = true; return nil })
			if err != nil {
				t.Fatalf("mergeByKey: %v", err)
			}
			if inserted != tc.wantInsert || updated != tc.wantUpdate {
				t.Errorf("insert=%v update=%v，want insert=%v update=%v", inserted, updated, tc.wantInsert, tc.wantUpdate)
			}
			if !strings.Contains(q.queries[0].sql, "FOR UPDATE") {
				t.Errorf("按主键查 updated_at 要 FOR UPDATE 锁行，got %s", q.queries[0].sql)
			}
		})
	}
}
