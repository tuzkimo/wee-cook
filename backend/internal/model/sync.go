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

// FileRef 是图片引用：字节走 /files 独立通道，同步体里只带文件名与大小。
type FileRef struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}
