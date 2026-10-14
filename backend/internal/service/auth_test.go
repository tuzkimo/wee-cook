package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"

	"wee-cook/backend/internal/model"
)

// --- 手写 fake dbQuerier（避免引入 pgxmock 依赖；生产传 pgxpool.Pool / pgx.Tx） ---

type fakeRow struct {
	scanErr error
	vals    []any
}

func (r fakeRow) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	for i, v := range r.vals {
		if i >= len(dest) {
			break
		}
		switch d := dest[i].(type) {
		case *time.Time:
			*d = v.(time.Time)
		case *string:
			*d = v.(string)
		case *bool:
			*d = v.(bool)
		}
	}
	return nil
}

type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, v := range row {
		if i >= len(dest) {
			break
		}
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case *time.Time:
			*d = v.(time.Time)
		}
	}
	return nil
}
func (r *fakeRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) Close()                                       {}

type execCall struct {
	sql  string
	args []any
}

type fakeQuerier struct {
	rows  []pgx.Row // QueryRow 队列
	execs []execCall
}

func (f *fakeQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return &fakeRows{}, nil
}

func (f *fakeQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if len(f.rows) > 0 {
		r := f.rows[0]
		f.rows = f.rows[1:]
		return r
	}
	return fakeRow{scanErr: pgx.ErrNoRows}
}

func (f *fakeQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, execCall{sql: sql, args: args})
	return pgconn.CommandTag{}, nil
}

func (f *fakeQuerier) execSQLContains(sub string) bool {
	for _, e := range f.execs {
		if strings.Contains(e.sql, sub) {
			return true
		}
	}
	return false
}

// fakeExec 是只用于 insertUser 的 dbQuerier 手写 fake：Exec 返回可配置错误。
type fakeExec struct {
	err error
}

func (f fakeExec) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, nil
}

func (f fakeExec) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return nil
}

func (f fakeExec) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, f.err
}

func newTestAuthService(q dbQuerier) *AuthService {
	return &AuthService{db: q, jwtSecret: []byte("test-secret")}
}

func TestRegisterRejectsDuplicateUsername(t *testing.T) {
	// SELECT EXISTS(SELECT 1 FROM users WHERE username = $1) → true
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}}

	_, err := newTestAuthService(fq).Register(context.Background(), model.RegisterRequest{
		Username: "taken",
		Password: "secret-password",
	})
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("重名注册应返回 ErrUsernameTaken，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("重名注册不应写库，got Exec: %+v", fq.execs)
	}
}

// wee-cook 没有账本抽象：注册只允许写 users 一行，不得出现任何 ledgers 写入。
// 这条钉的是「照抄 wee-count 时把建账本那段删掉」这个删减点。
func TestRegisterCreatesOnlyUser(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}} // 用户名未占用

	resp, err := newTestAuthService(fq).Register(context.Background(), model.RegisterRequest{
		Username: "alice",
		Password: "secret-password",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if resp.AccessToken == "" || resp.RefreshToken == "" {
		t.Fatalf("注册应返回双 token，got %+v", resp)
	}
	if resp.User.Username != "alice" || resp.User.Nickname != "alice" {
		t.Fatalf("用户字段不符，got %+v", resp.User)
	}

	if len(fq.execs) != 1 {
		t.Fatalf("注册应只写一条 INSERT，got %+v", fq.execs)
	}
	if !strings.Contains(fq.execs[0].sql, "INSERT INTO users") {
		t.Fatalf("注册唯一的写库语句应是 INSERT INTO users，got %s", fq.execs[0].sql)
	}
	if fq.execSQLContains("ledger") {
		t.Fatalf("wee-cook 无账本抽象，注册不应写 ledgers：%+v", fq.execs)
	}
}

// 密码不匹配与用户不存在必须返回同一个 ErrInvalidLogin（不泄露账号是否存在）。
func TestLoginWrongPassword(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("correct-horse"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}
	now := time.Now().UTC()
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{
		"u1", "alice", "Alice", string(hash), nil, now, now,
	}}}}

	_, err = newTestAuthService(fq).Login(context.Background(), model.LoginRequest{
		Username: "alice",
		Password: "wrong-password",
	})
	if !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("密码错误应返回 ErrInvalidLogin，got %v", err)
	}

	// 用户不存在：同一错误值，响应文案与密码错误不可区分
	fqMissing := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: pgx.ErrNoRows}}}
	_, err = newTestAuthService(fqMissing).Login(context.Background(), model.LoginRequest{
		Username: "ghost",
		Password: "whatever",
	})
	if !errors.Is(err, ErrInvalidLogin) {
		t.Fatalf("用户不存在应与密码错误返回同一 ErrInvalidLogin，got %v", err)
	}
}

// access token（typ=access）不得当 refresh token 用来换新 token。
func TestRefreshRejectsAccessToken(t *testing.T) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "u1",
		"typ": "access",
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	signed, err := tok.SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatalf("SignedString: %v", err)
	}

	_, err = newTestAuthService(&fakeQuerier{}).Refresh(context.Background(), model.RefreshRequest{
		RefreshToken: signed,
	})
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("access token 调 Refresh 应返回 ErrInvalidToken，got %v", err)
	}
}

// 并发同名注册撞 users_username_unique（23505）时，insertUser 应映射为
// ErrUsernameTaken（409），而非把唯一冲突当作 500 返回。
func TestInsertUserUniqueViolationReturnsErrUsernameTaken(t *testing.T) {
	q := fakeExec{err: &pgconn.PgError{Code: "23505"}}
	err := insertUser(context.Background(), q, "id-1", "dup", "dup", "hash", time.Now())
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("23505 应返回 ErrUsernameTaken，got %v", err)
	}
}

// 非 23505 的其它 DB 错误应透传（包一层 insert user），不得误映射为 ErrUsernameTaken。
func TestInsertUserNonUniqueErrorWraps(t *testing.T) {
	realErr := errors.New("connection reset by peer")
	q := fakeExec{err: realErr}
	err := insertUser(context.Background(), q, "id-1", "u", "u", "hash", time.Now())
	if !errors.Is(err, realErr) {
		t.Fatalf("非 23505 错误应透传，got %v", err)
	}
	if errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("非 23505 错误不应映射为 ErrUsernameTaken，got %v", err)
	}
}
