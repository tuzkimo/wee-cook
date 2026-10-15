package database_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"wee-cook/backend/internal/database"
)

// tableExists 报告库里是否存在该名字的表。
func tableExists(ctx context.Context, t *testing.T, pool *pgxpool.Pool, table string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)", table).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// recipeColumn 报告 recipes 表上是否有该名字的列。
func recipeColumn(ctx context.Context, t *testing.T, pool *pgxpool.Pool, column string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'recipes' AND column_name = $1)",
		column).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

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
		"users", "recipes", "recipe_steps",
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

	// teams 与 team_members 必须不存在了
	if tableExists(context.Background(), t, pool, "teams") || tableExists(context.Background(), t, pool, "team_members") {
		t.Error("团队表应已删除")
	}

	// recipes 带 is_public、不带 team_id
	var dataType, isNullable, columnDefault string
	if err := pool.QueryRow(context.Background(),
		`SELECT data_type, is_nullable, column_default FROM information_schema.columns
		 WHERE table_name = 'recipes' AND column_name = 'is_public'`).
		Scan(&dataType, &isNullable, &columnDefault); err != nil {
		t.Fatalf("recipes.is_public 应存在: %v", err)
	}
	if dataType != "smallint" || isNullable != "NO" || columnDefault != "0" {
		t.Errorf("recipes.is_public = %s / %s / %s, want smallint / NO / 0", dataType, isNullable, columnDefault)
	}
	if recipeColumn(context.Background(), t, pool, "team_id") {
		t.Error("recipes 不应再有 team_id 列")
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
