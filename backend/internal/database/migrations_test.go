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

// columnExists 报告某表上是否有该名字的列。
func columnExists(ctx context.Context, t *testing.T, pool *pgxpool.Pool, table, column string) bool {
	t.Helper()
	var ok bool
	if err := pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2)",
		table, column).Scan(&ok); err != nil {
		t.Fatal(err)
	}
	return ok
}

// recipeColumn 报告 recipes 表上是否有该名字的列。
func recipeColumn(ctx context.Context, t *testing.T, pool *pgxpool.Pool, column string) bool {
	t.Helper()
	return columnExists(ctx, t, pool, "recipes", column)
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
		"teams", "team_members", "inventory_batches", "inventory_usages", "cook_records",
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

	// 社区表必须不存在了
	for _, table := range []string{"favorites", "follows"} {
		if tableExists(context.Background(), t, pool, table) {
			t.Errorf("%s 表应已删除", table)
		}
	}

	// 制作记录是真实体：范围两列 + 由 LEFT JOIN users 派生的作者两列（后者只在响应里，不落库）
	for _, column := range []string{"id", "owner_id", "team_id", "recipe_id", "created_at", "updated_at", "deleted_at", "server_seq"} {
		if !columnExists(context.Background(), t, pool, "cook_records", column) {
			t.Errorf("cook_records 应有 %s 列", column)
		}
	}
	if !columnExists(context.Background(), t, pool, "inventory_usages", "cook_id") {
		t.Error("inventory_usages 应有 cook_id 列")
	}

	// recipes 带 team_id、不带 is_public
	if !recipeColumn(context.Background(), t, pool, "team_id") {
		t.Error("recipes 应有 team_id 列")
	}
	if recipeColumn(context.Background(), t, pool, "is_public") {
		t.Error("recipes 不应再有 is_public 列")
	}

	// 字典三表带范围列：team_id 可空（个人字典），owner_id 记录个人字典的归属
	for _, table := range []string{"ingredients", "units", "labels"} {
		if !columnExists(context.Background(), t, pool, table, "team_id") {
			t.Errorf("%s 应有 team_id 列", table)
		}
		if !columnExists(context.Background(), t, pool, table, "owner_id") {
			t.Errorf("%s 应有 owner_id 列", table)
		}
	}

	// 库存两张表：批次有 produced_at / expires_at，使用记录只有 used_at（没有 created_at）
	for _, column := range []string{"owner_id", "team_id", "ingredient_id", "amount", "unit_id", "produced_at", "shelf_life_days", "expires_at", "server_seq"} {
		if !columnExists(context.Background(), t, pool, "inventory_batches", column) {
			t.Errorf("inventory_batches 应有 %s 列", column)
		}
	}
	for _, column := range []string{"owner_id", "team_id", "recipe_id", "batch_id", "amount", "used_at", "updated_at", "deleted_at", "server_seq"} {
		if !columnExists(context.Background(), t, pool, "inventory_usages", column) {
			t.Errorf("inventory_usages 应有 %s 列", column)
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

	// team_members 是关系表，按规格不带 id / updated_at / deleted_at（AGENTS.md 的确认例外）
	for _, column := range []string{"id", "updated_at", "deleted_at"} {
		if columnExists(context.Background(), t, pool, "team_members", column) {
			t.Errorf("team_members 不应有 %s 列", column)
		}
	}
}
