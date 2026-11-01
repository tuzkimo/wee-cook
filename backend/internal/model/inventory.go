package model

import "time"

// InventoryBatch 是一条库存批次：余量永远由「批次数量 − 未删除的使用记录」派生，服务端不存余量列。
// ScopeID 与 Recipe 同形状（'p:<uid>' / 't:<teamId>'），服务端落成 team_id + owner_id 并校验。
// OwnerID 只在响应里有意义：请求里的值一律丢弃，新增取当前用户、更新保留原录入者（spec §8.3）。
// ProducedAt / ExpiresAt 是 YYYY-MM-DD 文本（保质期到「日」为止）。
type InventoryBatch struct {
	ID            string     `json:"id"`
	ScopeID       string     `json:"scope_id"`
	OwnerID       string     `json:"owner_id"`
	IngredientID  string     `json:"ingredient_id"`
	Amount        float64    `json:"amount"`
	UnitID        *string    `json:"unit_id"`
	ProducedAt    *string    `json:"produced_at"`
	ShelfLifeDays *int       `json:"shelf_life_days"`
	ExpiresAt     *string    `json:"expires_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	DeletedAt     *time.Time `json:"deleted_at"`
}

// InventoryUsage 是一条扣减记录：只增不清，used_at 就是发生时间（没有 created_at）。
type InventoryUsage struct {
	ID      string `json:"id"`
	ScopeID string `json:"scope_id"`
	OwnerID string `json:"owner_id"`
	// CookID 归属到那条制作记录；老客户端 / 开发库里的存量行是 NULL（不做回填）。
	// 不做存在性校验：记录被范围校验跳过时宁可保留这条扣减（丢了它余量永久对不上）。
	CookID    *string    `json:"cook_id"`
	RecipeID  string     `json:"recipe_id"`
	BatchID   string     `json:"batch_id"`
	Amount    float64    `json:"amount"`
	UsedAt    time.Time  `json:"used_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}
