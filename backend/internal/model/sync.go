package model

// SyncRequest 是一次同步请求：客户端带上本地游标和本地未同步的改动。
type SyncRequest struct {
	LastServerSeq int64       `json:"last_server_seq"`
	LocalChanges  SyncPayload `json:"local_changes"`
}

// SyncPayload 是双向同步的载荷。推送时 Files 为空；响应里 Recipes 额外带 owner_id。
type SyncPayload struct {
	Ingredients []Ingredient `json:"ingredients"`
	Units       []Unit       `json:"units"`
	Labels      []Label      `json:"labels"`
	Recipes     []Recipe     `json:"recipes"`
	Files       []FileRef    `json:"files"`
}

// SyncResponse 是一次同步的响应：新游标（客户端下次带回）与本次增量。
// FavoriteRecipeIDs 是「我当前有效的收藏」（作者仍公开、未删除的），客户端拿它整表替换本地收藏。
type SyncResponse struct {
	ServerSeq         int64       `json:"server_seq"`
	RemoteChanges     SyncPayload `json:"remote_changes"`
	FavoriteRecipeIDs []string    `json:"favorite_recipe_ids"`
}

// FileRef 是图片引用：字节走 /files 独立通道，同步体里只带文件名与大小。
type FileRef struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}
