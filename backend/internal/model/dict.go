package model

import "time"

// Ingredient / Unit / Label 是字典行，按范围（个人 / 团队）共享，服务端落成 team_id + owner_id。
// ScopeID 是客户端给出的范围形状：'p:<uid>' 个人、't:<teamId>' 团队（spec §8.1）。
// DeletedAt 用指针表示墓碑：NULL = 未删除，非 NULL 即软删时间。
type Ingredient struct {
	ID        string     `json:"id"`
	ScopeID   string     `json:"scope_id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}

type Unit struct {
	ID        string     `json:"id"`
	ScopeID   string     `json:"scope_id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}

// Label 的 Kind 是「分类 / 标签」的区分：同名不同 kind 是两条记录（spec §7.4）。
type Label struct {
	ID        string     `json:"id"`
	ScopeID   string     `json:"scope_id"`
	Name      string     `json:"name"`
	Kind      string     `json:"kind"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at"`
}
