package database_test

import (
	"context"
	"testing"

	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"wee-cook/backend/internal/database"
)

// startPostgres 起一个临时 postgres 容器并返回连接串（testcontainers / Ryuk 负责回收）。
func startPostgres(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("test"),
		postgres.WithUsername("test"),
		postgres.WithPassword("test"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		t.Fatalf("启动 postgres 容器失败: %v", err)
	}
	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("取连接串失败: %v", err)
	}
	return dsn
}

func TestMigrationsCreateAllTables(t *testing.T) {
	url := startPostgres(t)
	if err := database.RunMigrations(url); err != nil {
		t.Fatalf("第一次迁移失败: %v", err)
	}
	if err := database.RunMigrations(url); err != nil {
		t.Fatalf("第二次迁移应幂等，却失败: %v", err)
	}

	pool, err := database.NewPool(context.Background(), url)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	for _, table := range []string{
		"users", "teams", "team_members", "recipes", "recipe_steps",
		"recipe_ingredients", "recipe_labels", "ingredients", "units", "labels", "files",
	} {
		var exists bool
		if err := pool.QueryRow(context.Background(),
			"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)", table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Errorf("迁移后应存在表 %s", table)
		}
	}

	// 三张子表按规格不带 deleted_at（AGENTS.md 的确认例外）
	for _, table := range []string{"recipe_steps", "recipe_ingredients", "recipe_labels"} {
		var exists bool
		if err := pool.QueryRow(context.Background(),
			"SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='deleted_at')", table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Errorf("%s 不应有 deleted_at 列", table)
		}
	}
}
