package service

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotTeamMember 表示调用者不是该团队成员（越权防护）。
var ErrNotTeamMember = errors.New("not a team member")

// canReadTeam 校验 userID 是否属于 teamID，非成员返回 ErrNotTeamMember。
func canReadTeam(ctx context.Context, q dbQuerier, userID, teamID string) error {
	var ok bool
	err := q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
		teamID, userID).Scan(&ok)
	if err != nil {
		return fmt.Errorf("check team membership: %w", err)
	}
	if !ok {
		return ErrNotTeamMember
	}
	return nil
}

// myTeamIDs 返回用户加入的全部团队 id，供同步服务的可见范围过滤与 team_id 合法性校验共用。
func myTeamIDs(ctx context.Context, q dbQuerier, userID string) (map[string]bool, error) {
	rows, err := q.Query(ctx, "SELECT team_id FROM team_members WHERE user_id = $1", userID)
	if err != nil {
		return nil, fmt.Errorf("query my teams: %w", err)
	}
	defer rows.Close()

	ids := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan team id: %w", err)
		}
		ids[id] = true
	}
	return ids, rows.Err()
}
