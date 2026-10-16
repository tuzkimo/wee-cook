package config_test

import (
	"slices"
	"strings"
	"testing"
	"time"

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

func TestLoadAIDefaultsDoNotBlockStartup(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_API_KEY", "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("没配 AI 时不该启动失败: %v", err)
	}
	if cfg.AIEnabled() {
		t.Error("AI_API_KEY 为空时 AIEnabled() 应为 false")
	}
	if cfg.AIModel != "deepseek-flash" {
		t.Errorf("AIModel 默认必须是 deepseek-flash（deepseek-chat 不接受图片），实际 %q", cfg.AIModel)
	}
	if cfg.AIBaseURL != "https://api.deepseek.com/v1" {
		t.Errorf("AIBaseURL 默认值不符，实际 %q", cfg.AIBaseURL)
	}
	if cfg.AIMaxTokens != 1024 {
		t.Errorf("AIMaxTokens 默认应是 1024，实际 %d", cfg.AIMaxTokens)
	}
	if cfg.AITimeout != 120*time.Second {
		t.Errorf("AITimeout 默认应是 120s，实际 %v", cfg.AITimeout)
	}
	if cfg.AIRateLimit != 20 {
		t.Errorf("AIRateLimit 默认应是 20，实际 %d", cfg.AIRateLimit)
	}
	if cfg.AIDailyLimit != 200 {
		t.Errorf("AIDailyLimit 默认应是 200，实际 %d", cfg.AIDailyLimit)
	}
}

func TestLoadAIEnvOverrides(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_API_KEY", "sk-x")
	t.Setenv("AI_BASE_URL", "https://example.com/v1/")
	t.Setenv("AI_MODEL", "qwen-vl-max")
	t.Setenv("AI_MAX_TOKENS", "256")
	t.Setenv("AI_TIMEOUT", "90s")
	t.Setenv("AI_RATE_LIMIT", "5")
	t.Setenv("AI_DAILY_LIMIT", "9")

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AIEnabled() {
		t.Error("配了 AI_API_KEY 后 AIEnabled() 应为 true")
	}
	if cfg.AIModel != "qwen-vl-max" || cfg.AIMaxTokens != 256 || cfg.AIRateLimit != 5 ||
		cfg.AIDailyLimit != 9 || cfg.AITimeout != 90*time.Second {
		t.Errorf("AI 环境变量没被读入: %+v", cfg)
	}
}

func TestLoadAIInvalidTimeoutFallsBack(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_TIMEOUT", "不是时长")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AITimeout != 120*time.Second {
		t.Errorf("非法 AI_TIMEOUT 应回落默认值，实际 %v", cfg.AITimeout)
	}
}
