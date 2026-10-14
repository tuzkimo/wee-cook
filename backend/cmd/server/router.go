// backend/cmd/server/router.go
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"wee-cook/backend/internal/config"
)

// handlers 汇总路由需要的 handler，避免 newRouter 的参数列表过长。
// 此刻为空，后续任务往里加字段。
type handlers struct{}

// newRouter 构造完整路由。**从 main 抽出来是为了让测试能直接断言中间件顺序**：
// 测试若自己重建一个路由，验证的就是测试里的顺序而不是生产的顺序，
// 那种测试永远是绿的、等于没测。
func newRouter(cfg *config.Config, h handlers) http.Handler {
	_ = h // 后续任务的 handler 从这里取；此刻结构体为空
	r := chi.NewRouter()
	// 仅在显式声明信任反向代理时启用 RealIP：它会用 X-Forwarded-For / X-Real-IP 改写
	// r.RemoteAddr。若服务被直接访问（未走 Caddy 等反代），客户端可伪造该 header 让每次
	// 请求换个 IP，从而绕过后续按 IP 的登录/注册/入组限流。默认不信任，按 socket peer 限流。
	if cfg.TrustProxy {
		r.Use(middleware.RealIP)
	}
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSAllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})
	})

	return r
}
