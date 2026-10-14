// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"
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

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      newRouter(cfg, handlers{auth: handler.NewAuthHandler(authSvc)}),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second, // 图片下载的写超时放宽
	}
	log.Printf("server starting on :%s", cfg.Port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
