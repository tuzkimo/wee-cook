package model

import "time"

// Team 是团队（家庭）。MemberCount 只在团队列表与加入响应里填，
// 让客户端一次拿到成员数，不用再发一轮请求。
type Team struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	MemberCount int       `json:"member_count"`
}

type TeamMember struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Nickname  string    `json:"nickname"`
	AvatarURL *string   `json:"avatar_url"`
	Role      string    `json:"role"`
	JoinedAt  time.Time `json:"joined_at"`
}
