package model

import "time"

// RecipeStep / RecipeIngredient 是菜谱的子行：它们跟着父菜谱整条上下发，不做行级增量（spec §7.3）。
type RecipeStep struct {
	ID        string  `json:"id"`
	SortOrder int     `json:"sort_order"`
	Text      string  `json:"text"`
	ImagePath *string `json:"image_path"`
}

type RecipeIngredient struct {
	ID           string   `json:"id"`
	IngredientID string   `json:"ingredient_id"`
	Amount       *float64 `json:"amount"`
	UnitID       *string  `json:"unit_id"`
	SortOrder    int      `json:"sort_order"`
}

// Recipe 整条同步。OwnerID 只在响应里有意义，请求里带的值一律丢弃（服务端赋值，spec §7.1）。
// IsPublic 0 = 私有（默认），1 = 公开到社区；由菜谱主人的客户端写入。
// 三个子集合不加 omitempty：空数组要能表达「清空」。
type Recipe struct {
	ID          string             `json:"id"`
	OwnerID     string             `json:"owner_id"`
	IsPublic    int16              `json:"is_public"`
	Name        string             `json:"name"`
	CoverPath   *string            `json:"cover_path"`
	CategoryID  string             `json:"category_id"`
	CreatedAt   time.Time          `json:"created_at"`
	UpdatedAt   time.Time          `json:"updated_at"`
	DeletedAt   *time.Time         `json:"deleted_at"`
	Steps       []RecipeStep       `json:"steps"`
	Ingredients []RecipeIngredient `json:"ingredients"`
	LabelIDs    []string           `json:"label_ids"`
}
