package service

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"wee-cook/backend/internal/model"
)

// 库存两张表的合并规则（spec §8.3）：
//   - 批次：LWW on updated_at；新增行 owner_id 取当前用户，更新保留原 owner_id；
//     范围不允许变（库里那条不在这次推送的范围里就整条跳过）。
//   - 使用记录：只增不清。同一 id 只落一行，绝不 UPDATE / DELETE；批次必须在服务器上存在
//     （含已软删的批次）且范围一致，否则跳过该条。

// mergeBatch 合并一条库存批次。
func (s *SyncService) mergeBatch(ctx context.Context, tx dbQuerier, userID string, sc scope, b model.InventoryBatch) error {
	var remoteOwner string
	var remoteTeamID *string
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT owner_id, team_id::text, updated_at FROM inventory_batches WHERE id = $1 FOR UPDATE", b.ID).
		Scan(&remoteOwner, &remoteTeamID, &remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err := tx.Exec(ctx,
			`INSERT INTO inventory_batches (id, owner_id, team_id, ingredient_id, amount, unit_id,
			        produced_at, shelf_life_days, expires_at, created_at, updated_at, deleted_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			b.ID, userID, sc.TeamID, b.IngredientID, b.Amount, b.UnitID,
			b.ProducedAt, b.ShelfLifeDays, b.ExpiresAt, b.CreatedAt, b.UpdatedAt, b.DeletedAt)
		return err
	}
	if err != nil {
		return err
	}
	if !sameTeam(remoteTeamID, sc.TeamID) {
		return nil
	}
	if !b.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE inventory_batches SET ingredient_id=$1, amount=$2, unit_id=$3, produced_at=$4,
		        shelf_life_days=$5, expires_at=$6, updated_at=$7, deleted_at=$8,
		        server_seq = nextval('global_server_seq') WHERE id=$9`,
		b.IngredientID, b.Amount, b.UnitID, b.ProducedAt, b.ShelfLifeDays, b.ExpiresAt,
		b.UpdatedAt, b.DeletedAt, b.ID)
	return err
}

// mergeCookRecord 合并一条制作记录（骨架同 mergeBatch）：新增 owner_id 取当前用户、
// team_id 取解析好的范围；范围不允许变（库里那条不在这次推送的范围里就整条跳过）。
// 请求里带的作者两列不落库：它们由服务端 JOIN users 派生。
func (s *SyncService) mergeCookRecord(ctx context.Context, tx dbQuerier, userID string, sc scope, cr model.CookRecord) error {
	var remoteTeamID *string
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT team_id::text, updated_at FROM cook_records WHERE id = $1 FOR UPDATE", cr.ID).
		Scan(&remoteTeamID, &remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err := tx.Exec(ctx,
			`INSERT INTO cook_records (id, owner_id, team_id, recipe_id, created_at, updated_at, deleted_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			cr.ID, userID, sc.TeamID, cr.RecipeID, cr.CreatedAt, cr.UpdatedAt, cr.DeletedAt)
		return err
	}
	if err != nil {
		return err
	}
	if !sameTeam(remoteTeamID, sc.TeamID) {
		return nil
	}
	if !cr.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE cook_records SET recipe_id=$1, updated_at=$2, deleted_at=$3,
		        server_seq = nextval('global_server_seq') WHERE id=$4`,
		cr.RecipeID, cr.UpdatedAt, cr.DeletedAt, cr.ID)
	return err
}

// insertUsage 落一条扣减记录（幂等）。批次查不到或范围不一致时跳过。
// 批次查询不筛 deleted_at：成员离线期间批次被删，他记的扣减若被丢弃，余量会永久对不上且不会自愈。
func (s *SyncService) insertUsage(ctx context.Context, tx dbQuerier, userID string, sc scope, u model.InventoryUsage) error {
	var batchTeamID *string
	err := tx.QueryRow(ctx, "SELECT team_id::text FROM inventory_batches WHERE id = $1", u.BatchID).Scan(&batchTeamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !sameTeam(batchTeamID, sc.TeamID) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO inventory_usages (id, owner_id, team_id, cook_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
		u.ID, userID, sc.TeamID, u.CookID, u.RecipeID, u.BatchID, u.Amount, u.UsedAt, u.UpdatedAt, u.DeletedAt)
	return err
}

// queryBatches 读「我看得见的批次」增量：个人范围是我的，团队范围是我加入且未解散团队的。
// 别名取 r 是为了复用 visibleRecipesSQL（同一条可见范围 SQL，两张表列名一致）。
func queryBatches(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) ([]model.InventoryBatch, error) {
	return queryList(ctx, q,
		`SELECT id, team_id::text, owner_id, ingredient_id, amount, unit_id, produced_at,
		        shelf_life_days, expires_at, created_at, updated_at, deleted_at
		 FROM inventory_batches r
		 WHERE r.server_seq > $1 AND `+visibleRecipesSQL+`
		 ORDER BY id`,
		[]any{sinceSeq, userID}, func(rows pgx.Rows) (model.InventoryBatch, error) {
			var b model.InventoryBatch
			var teamID *string
			err := rows.Scan(&b.ID, &teamID, &b.OwnerID, &b.IngredientID, &b.Amount, &b.UnitID,
				&b.ProducedAt, &b.ShelfLifeDays, &b.ExpiresAt, &b.CreatedAt, &b.UpdatedAt, &b.DeletedAt)
			if teamID != nil {
				b.ScopeID = "t:" + *teamID
			} else {
				b.ScopeID = "p:" + b.OwnerID
			}
			return b, err
		})
}

// queryUsages 读使用记录增量：范围条件与批次同口径（usages 自带 team_id）。
func queryUsages(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) ([]model.InventoryUsage, error) {
	return queryList(ctx, q,
		`SELECT id, team_id::text, owner_id, cook_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at
		 FROM inventory_usages r
		 WHERE r.server_seq > $1 AND `+visibleRecipesSQL+`
		 ORDER BY id`,
		[]any{sinceSeq, userID}, func(rows pgx.Rows) (model.InventoryUsage, error) {
			var u model.InventoryUsage
			var teamID *string
			err := rows.Scan(&u.ID, &teamID, &u.OwnerID, &u.CookID, &u.RecipeID, &u.BatchID, &u.Amount,
				&u.UsedAt, &u.UpdatedAt, &u.DeletedAt)
			if teamID != nil {
				u.ScopeID = "t:" + *teamID
			} else {
				u.ScopeID = "p:" + u.OwnerID
			}
			return u, err
		})
}

// queryCookRecords 读制作记录增量：可见范围与批次 / 菜谱同一条 SQL。
// 作者两列由 LEFT JOIN users 派生（与菜谱一致），users.id 是主键，不改变行数。
func queryCookRecords(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) ([]model.CookRecord, error) {
	return queryList(ctx, q,
		`SELECT r.id, r.team_id::text, r.owner_id, r.recipe_id, r.created_at, r.updated_at, r.deleted_at,
		        u.nickname, u.avatar_url
		 FROM cook_records r LEFT JOIN users u ON u.id = r.owner_id
		 WHERE r.server_seq > $1 AND `+visibleRecipesSQL+`
		 ORDER BY r.id`,
		[]any{sinceSeq, userID}, func(rows pgx.Rows) (model.CookRecord, error) {
			var cr model.CookRecord
			var teamID *string
			err := rows.Scan(&cr.ID, &teamID, &cr.OwnerID, &cr.RecipeID, &cr.CreatedAt, &cr.UpdatedAt,
				&cr.DeletedAt, &cr.OwnerNickname, &cr.OwnerAvatarURL)
			if teamID != nil {
				cr.ScopeID = "t:" + *teamID
			} else {
				cr.ScopeID = "p:" + cr.OwnerID
			}
			return cr, err
		})
}

// backfillInventoryDicts 补齐「增量批次引用到、但本次没下发的字典行」：与菜谱同一套父行补齐，
// 不补客户端就缺外键行（批次引用的食材 / 单位可能三天前就建好了）。
func backfillInventoryDicts(ctx context.Context, q dbQuerier, userID string, payload *model.SyncPayload) error {
	refIngredients, refUnits := map[string]bool{}, map[string]bool{}
	for _, b := range payload.InventoryBatches {
		refIngredients[b.IngredientID] = true
		if b.UnitID != nil {
			refUnits[*b.UnitID] = true
		}
	}
	if ids := pendingIDs(refIngredients, payload.Ingredients, func(it model.Ingredient) string { return it.ID }); len(ids) > 0 {
		extra, err := queryIngredientsByIDs(ctx, q, userID, ids)
		if err != nil {
			return err
		}
		payload.Ingredients = append(payload.Ingredients, extra...)
	}
	if ids := pendingIDs(refUnits, payload.Units, func(it model.Unit) string { return it.ID }); len(ids) > 0 {
		extra, err := queryUnitsByIDs(ctx, q, userID, ids)
		if err != nil {
			return err
		}
		payload.Units = append(payload.Units, extra...)
	}
	return nil
}
