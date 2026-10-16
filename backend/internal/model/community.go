package model

import "time"

// UserProfile 是用户资料页对外返回的视图（spec §8）。
// Followed 是相对当前查看者而言的：同一份资料，换个查看者取值就可能不同。
type UserProfile struct {
	ID          string  `json:"id"`
	Nickname    string  `json:"nickname"`
	AvatarURL   *string `json:"avatar_url"`
	Followed    bool    `json:"followed"`
	PublicCount int     `json:"public_count"`
}

// CommunityRecipe 是社区列表里的一行：只够画一张卡片，正文走详情接口（spec §8）。
// Favorited 是相对当前查看者而言的，与 UserProfile.Followed 同理。
type CommunityRecipe struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	CoverPath       *string   `json:"cover_path"`
	AuthorID        string    `json:"author_id"`
	AuthorNickname  string    `json:"author_nickname"`
	AuthorAvatarURL *string   `json:"author_avatar_url"`
	CategoryName    *string   `json:"category_name"` // 没分类时为 null
	Tags            []string  `json:"tags"`          // 没标签时是 []，不是 null
	UpdatedAt       time.Time `json:"updated_at"`
	Favorited       bool      `json:"favorited"`
}

// CommunityListOptions 是列表的筛选与翻页条件。Limit / Offset 的规范化由服务层负责，
// 这里不做默认值——调用方传什么就是什么，避免同一份默认值写在两处。
type CommunityListOptions struct {
	Limit        int
	Offset       int
	AuthorID     string
	FollowedOnly bool
}
