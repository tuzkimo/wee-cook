package config_test

import (
	"slices"
	"strings"
	"testing"

	"wee-cook/backend/internal/config"
)

func TestLoadRequiresCoreEnv(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("JWT_SECRET", "")
	_, err := config.Load()
	if err == nil {
		t.Fatal("期望缺少必填环境变量时报错")
	}
	for _, want := range []string{"DATABASE_URL", "REDIS_URL", "JWT_SECRET"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误信息里应提到 %s，实际：%v", want, err)
		}
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port 默认值应是 8080，实际 %q", cfg.Port)
	}
	if cfg.MaxFileBytes != 5<<20 {
		t.Errorf("MaxFileBytes 默认值应是 5MB，实际 %d", cfg.MaxFileBytes)
	}
	if cfg.FilesDir != "/data/files" {
		t.Errorf("FilesDir 默认值应是 /data/files，实际 %q", cfg.FilesDir)
	}
	if !slices.Contains(cfg.CORSAllowedOrigins, "http://tauri.localhost") {
		t.Errorf("默认 CORS 必须含 http://tauri.localhost，实际 %v", cfg.CORSAllowedOrigins)
	}
}
