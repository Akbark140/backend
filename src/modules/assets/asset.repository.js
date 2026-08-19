// asset.repository.js
const db = require('../../config/db.config'); // Path to your db.config.js file

class AssetRepository {
    /**
     * Creates an asset record.
     * Can execute within a transaction if a custom client/tx wrapper is provided.
     */
    async createAsset(userId, data, txExecutor = null) {
        const executor = txExecutor || db;
        const queryConfig = {
            name: 'create-asset-metadata',
            text: `
        INSERT INTO public.assets 
          (user_id, name, type, quantity, currency, purchase_price, purchase_date, institution_or_location, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `
        };

        const params = [
            userId, data.name, data.type, data.quantity, data.currency,
            data.purchase_price, data.purchase_date, data.institution_or_location, data.note
        ];

        const res = await executor.query(queryConfig, params);
        return res.rows[0];
    }

    /**
     * Appends an entry to the asset valuation history timeline.
     */
    async addValuation(assetId, data, txExecutor = null) {
        const executor = txExecutor || db;
        const queryConfig = {
            name: 'add-asset-valuation',
            text: `
        INSERT INTO public.asset_valuations 
          (asset_id, unit_price, total_value_in_base_currency, exchange_rate_used)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `
        };

        const params = [assetId, data.unit_price, data.total_value_in_base_currency, data.exchange_rate_used];
        const res = await executor.query(queryConfig, params);
        return res.rows[0];
    }

    /**
     * Reads all non-deleted assets alongside their absolute latest timeline valuation.
     */
    async getUserAssetsWithLatestValue(userId) {
        const queryConfig = {
            name: 'get-user-assets-summary',
            text: `
        SELECT 
          a.id,
          a.name,
          a.type,
          a.quantity,
          a.currency,
          a.purchase_price,
          a.purchase_date,
          a.institution_or_location,
          a.note,
          a.created_at,
          COALESCE(lv.total_value_in_base_currency, 0.00) AS current_value_in_base_currency,
          lv.unit_price AS current_unit_price,
          lv.valuation_date AS last_valued_at
        FROM public.assets a
        LEFT JOIN (
          SELECT DISTINCT ON (asset_id) asset_id, total_value_in_base_currency, unit_price, valuation_date
          FROM public.asset_valuations
          ORDER BY asset_id, valuation_date DESC
        ) lv ON a.id = lv.asset_id
        WHERE a.user_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at DESC;
      `
        };

        const res = await db.query(queryConfig, [userId]);
        return res.rows;
    }

    /**
     * Gets a specific asset by ID for access control validation.
     */
    async getAssetById(assetId, userId) {
        const queryConfig = {
            name: 'get-asset-by-id',
            text: `SELECT * FROM public.assets WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL;`
        };

        const res = await db.query(queryConfig, [assetId, userId]);
        return res.rows[0];
    }

    async getNetWorthHistory(userId) {
        const queryConfig = {
            name: 'get-net-worth-history',
            text: `
      SELECT 
        DATE(av.valuation_date) AS valuation_day,
        SUM(av.total_value_in_base_currency) AS total_net_worth_on_day
      FROM public.asset_valuations av
      JOIN public.assets a ON av.asset_id = a.id
      WHERE a.user_id = $1 AND a.deleted_at IS NULL
      GROUP BY DATE(av.valuation_date)
      ORDER BY valuation_day ASC;
    `
        };
        const res = await db.query(queryConfig, [userId]);
        return res.rows;
    }
}

module.exports = { AssetRepository };