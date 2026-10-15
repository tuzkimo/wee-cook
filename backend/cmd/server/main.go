// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/database"
	"wee-cook/backend/internal/handler"
	"wee-cook/backend/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config.Load: %v", err)
	}

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("database.RunMigrations: %v", err)
	}
	log.Printf("migrations applied")

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database.NewPool: %v", err)
	}
	defer pool.Close()

	redisClient, err := database.NewRedisClient(cfg.RedisURL, cfg.RedisPassword)
	if err != nil {
		log.Fatalf("database.NewRedisClient: %v", err)
	}
	defer redisClient.Close()

	authSvc := service.NewAuthService(pool, cfg.JWTSecret)
	syncSvc := service.NewSyncService(pool)
	// 图片目录提前建好：启动时就报错，比第一次上传才发现目录不在强
	if err := os.MkdirAll(cfg.FilesDir, 0o755); err != nil {
		log.Fatalf("创建 FILES_DIR %s: %v", cfg.FilesDir, err)
	}
	fileSvc := service.NewFileService(pool, cfg.FilesDir, cfg.MaxFileBytes)
	communitySvc := service.NewCommunityService(pool)

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: newRouter(cfg, handlers{
			auth:      handler.NewAuthHandler(authSvc),
			sync:      handler.NewSyncHandler(syncSvc),
			file:      handler.NewFileHandler(fileSvc),
			community: handler.NewCommunityHandler(communitySvc),
		}),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second, // 图片下载的写超时放宽
	}
	log.Printf("server starting on :%s", cfg.Port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
