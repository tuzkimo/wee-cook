// backend/internal/config/config.go
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL        string
	RedisURL           string
	RedisPassword      string
	JWTSecret          string
	Port               string
	CORSAllowedOrigins []string
	TrustProxy         bool

	FilesDir     string // FILES_DIR，默认 /data/files
	MaxFileBytes int64  // MAX_FILE_BYTES，默认 5<<20

	AIAPIKey     string        // AI_API_KEY，无默认；为空即 AI 功能关闭（不阻塞启动）
	AIBaseURL    string        // AI_BASE_URL，默认 https://api.deepseek.com/v1
	AIModel      string        // AI_MODEL，默认 deepseek-flash（deepseek-chat 不接受图片）
	AIMaxTokens  int           // AI_MAX_TOKENS，默认 1024
	AITimeout    time.Duration // AI_TIMEOUT，默认 120s
	AIRateLimit  int           // AI_RATE_LIMIT，默认每分钟 20 次
	AIDailyLimit int           // AI_DAILY_LIMIT，默认每天 200 次
}

const defaultMaxFileBytes = 5 << 20

const (
	defaultAIBaseURL    = "https://api.deepseek.com/v1"
	defaultAIModel      = "deepseek-flash"
	defaultAIMaxTokens  = 1024
	defaultAITimeout    = 120 * time.Second
	defaultAIRateLimit  = 20
	defaultAIDailyLimit = 200
)

// defaultCORSOrigins 覆盖开发期与 Android 正式包的来源：
// - http://tauri.localhost：Tauri 2 Android（及 Windows 桌面）webview 的 Origin
// - http://localhost:1420：Vite dev server，浏览器/桌面调试用
var defaultCORSOrigins = []string{"http://tauri.localhost", "http://localhost:1420"}

func Load() (*Config, error) {
	cfg := &Config{
		DatabaseURL:        getEnv("DATABASE_URL", ""),
		RedisURL:           getEnv("REDIS_URL", ""),
		RedisPassword:      getEnv("REDIS_PASSWORD", ""),
		JWTSecret:          getEnv("JWT_SECRET", ""),
		Port:               getEnv("PORT", "8080"),
		CORSAllowedOrigins: parseCORSOrigins(os.Getenv("CORS_ALLOWED_ORIGINS")),
		TrustProxy:         getEnvBool("TRUST_PROXY", false),
		FilesDir:           getEnv("FILES_DIR", "/data/files"),
		MaxFileBytes:       int64(getEnvInt("MAX_FILE_BYTES", defaultMaxFileBytes)),
		AIAPIKey:           getEnv("AI_API_KEY", ""),
		AIBaseURL:          getEnv("AI_BASE_URL", defaultAIBaseURL),
		AIModel:            getEnv("AI_MODEL", defaultAIModel),
		AIMaxTokens:        getEnvInt("AI_MAX_TOKENS", defaultAIMaxTokens),
		AITimeout:          getEnvDuration("AI_TIMEOUT", defaultAITimeout),
		AIRateLimit:        getEnvInt("AI_RATE_LIMIT", defaultAIRateLimit),
		AIDailyLimit:       getEnvInt("AI_DAILY_LIMIT", defaultAIDailyLimit),
	}

	missing := []string{}
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.RedisURL == "" {
		missing = append(missing, "REDIS_URL")
	}
	if cfg.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %v", missing)
	}

	return cfg, nil
}

// AIEnabled 报告是否配置了 AI 服务。未配 AI_API_KEY 时整条 AI 管道视为关闭，
// 但后端必须能正常启动，所以 AI_* 一个都不进 missing 必填校验。
func (c *Config) AIEnabled() bool {
	return c.AIAPIKey != ""
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getEnvBool 解析布尔环境变量："1"/"true"/"yes"/"on"（大小写不敏感）为真，其余为假。
// 空值回落到 fallback。用于 TRUST_PROXY 这类「默认关闭、显式开启」的安全开关。
func getEnvBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// parseCORSOrigins 解析逗号分隔的 CORS_ALLOWED_ORIGINS；为空时回落到默认集合。
// Origin 必须含 scheme（如 http://tauri.localhost），go-chi/cors 按完整字符串精确匹配。
func parseCORSOrigins(raw string) []string {
	if raw == "" {
		return defaultCORSOrigins
	}
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		if o := strings.TrimSpace(p); o != "" {
			origins = append(origins, o)
		}
	}
	if len(origins) == 0 {
		return defaultCORSOrigins
	}
	return origins
}

// getEnvDuration 解析时长环境变量（如 90s）。空值、解析失败、非正数一律回落 fallback：
// AI_TIMEOUT 配错只会让调用超时点偏离预期，静默回落比启动失败更合适。
func getEnvDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

// getEnvInt 解析整数环境变量。空值、非法值、非正数一律回落 fallback：
// 图片大小上限配成 0 或负数会让上传功能不可用或失去上限保护，静默回落比启动失败更合适。
func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
