// backend/cmd/server/router.go
package main

import (
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/handler"
	mw "wee-cook/backend/internal/middleware"
)

// handlers 汇总路由需要的 handler，避免 newRouter 的参数列表过长。
type handlers struct {
	auth      *handler.AuthHandler
	sync      *handler.SyncHandler
	file      *handler.FileHandler
	community *handler.CommunityHandler
}

// newRouter 构造完整路由。**从 main 抽出来是为了让测试能直接断言中间件顺序**：
// 测试若自己重建一个路由，验证的就是测试里的顺序而不是生产的顺序，
// 那种测试永远是绿的、等于没测。
func newRouter(cfg *config.Config, h handlers) http.Handler {
	r := chi.NewRouter()
	// 仅在显式声明信任反向代理时启用 RealIP：它会用 X-Forwarded-For / X-Real-IP 改写
	// r.RemoteAddr。若服务被直接访问（未走 Caddy 等反代），客户端可伪造该 header 让每次
	// 请求换个 IP，从而绕过下面按 IP 的登录/注册限流。默认不信任，按 socket peer 限流；
	// 处于可信反代之后时设 TRUST_PROXY=true 才恢复按真实客户端 IP 限流。
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

		// refresh 不限流：客户端静默续期高频，不参与暴力破解面
		r.Post("/auth/refresh", h.auth.Refresh)

		// 登录/注册按 IP 限流，防暴力破解。
		// key 取自 r.RemoteAddr：启用 TRUST_PROXY 时由 middleware.RealIP 从 X-Forwarded-For 解析，
		// 未启用时即 socket peer 地址（客户端无法伪造）。
		r.Group(func(r chi.Router) {
			r.Use(httprate.LimitBy(10, time.Minute, clientIPKey))
			r.Post("/auth/login", h.auth.Login)
			r.Post("/auth/register", h.auth.Register)
		})

		// protected
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthMiddleware(cfg.JWTSecret))
			r.Get("/me", h.auth.Me)
			r.Put("/auth/profile", h.auth.UpdateProfile)

			r.Post("/sync", h.sync.Sync)

			// 社区：浏览、收藏、关注（spec §8）。全部要求登录：内容与订阅关系都挂在我的身份上。
			r.Get("/community/recipes", h.community.ListRecipes)
			r.Get("/community/recipes/{id}", h.community.GetRecipe)
			r.Get("/users/{id}", h.community.GetProfile)
			r.Post("/favorites/{recipe_id}", h.community.Favorite)
			r.Delete("/favorites/{recipe_id}", h.community.Unfavorite)
			r.Post("/follows/{user_id}", h.community.Follow)
			r.Delete("/follows/{user_id}", h.community.Unfollow)

			// 图片走独立通道：body 是裸二进制，文件名由客户端给（spec §8.1）
			r.Post("/files", h.file.Upload)
			r.Get("/files/{name}", h.file.Download)
		})
	})

	return r
}

// clientIPKey 从 r.RemoteAddr 提取限流 key。未启用 TRUST_PROXY 时，r.RemoteAddr 是
// socket peer 地址（不可被客户端伪造），限流可信；启用后由 middleware.RealIP 改写为
// X-Forwarded-For 解析值，仅应在服务确实位于可信反代之后时开启。
func clientIPKey(r *http.Request) (string, error) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	return httprate.CanonicalizeIP(ip), nil
}
