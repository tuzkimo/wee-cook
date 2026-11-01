package model

import "time"

// CookRecord 是一次制作（制作记录设计 §4.2）：形状与 inventory_batches 同构，
// 参与 LWW（updated_at），因为将来会被编辑（心得）。
// OwnerNickname / OwnerAvatarURL 只在响应里有意义：服务端由 LEFT JOIN users 派生，推送时不落库。
type CookRecord struct {
	ID             string     `json:"id"`
	ScopeID        string     `json:"scope_id"`
	OwnerID        string     `json:"owner_id"`
	RecipeID       string     `json:"recipe_id"`
	OwnerNickname  *string    `json:"owner_nickname"`
	OwnerAvatarURL *string    `json:"owner_avatar_url"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	DeletedAt      *time.Time `json:"deleted_at"`
}
