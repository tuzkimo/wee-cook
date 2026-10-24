// backend/cmd/server/invites.go
package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisInvites 把 *redis.Client 收窄成 service 需要的邀请码接口（Get 用 (value, ok, err)，
// 把 redis.Nil 表达成「没有这个码」而不是错误）。
type redisInvites struct{ client *redis.Client }

func (r redisInvites) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := r.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (r redisInvites) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r redisInvites) Del(ctx context.Context, key string) error {
	return r.client.Del(ctx, key).Err()
}
