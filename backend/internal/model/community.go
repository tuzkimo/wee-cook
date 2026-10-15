package model

// UserProfile 是用户资料页对外返回的视图（spec §8）。
// Followed 是相对当前查看者而言的：同一份资料，换个查看者取值就可能不同。
type UserProfile struct {
	ID          string  `json:"id"`
	Nickname    string  `json:"nickname"`
	AvatarURL   *string `json:"avatar_url"`
	Followed    bool    `json:"followed"`
	PublicCount int     `json:"public_count"`
}
