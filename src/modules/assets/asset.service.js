// asset.service.js
const { withTransaction } = require('../../config/db.config');

class AssetService {
    constructor(assetRepository) {
        this.repo = assetRepository;
    }

    /**
     * Business Logic Algorithm: Safe Creation of Asset and its baseline valuation timeline point.
     */
    async createNewAsset(userId, dto) {
        // Leverage your custom proxy-wrapped database transaction workflow
        return await withTransaction(async (tx) => {
            // 1. Persist core asset metadata
            const newAsset = await this.repo.createAsset(userId, dto, tx);

            // 2. Financial calculation rules
            const exchangeRate = dto.exchange_rate_used || 1.0;
            const unitPriceInLocalCurrency = dto.purchase_price / dto.quantity;
            const totalValueInBaseCurrency = dto.purchase_price * exchangeRate;

            // 3. Chain initial valuation record using the same transaction frame
            await this.repo.addValuation(newAsset.id, {
                unit_price: unitPriceInLocalCurrency,
                total_value_in_base_currency: totalValueInBaseCurrency,
                exchange_rate_used: exchangeRate
            }, tx);

            // Append calculated virtual properties to return payload
            return {
                ...newAsset,
                current_value_in_base_currency: totalValueInBaseCurrency,
                current_unit_price: unitPriceInLocalCurrency
            };
        });
    }

    /**
     * Appends a new valuation record over time (e.g. for price fluctuations or crypto changes)
     */
    async recordNewValuation(userId, assetId, dto) {
        const asset = await this.repo.getAssetById(assetId, userId);
        if (!asset) {
            const error = new Error('Asset not found or unauthorized access');
            error.statusCode = 404;
            throw error;
        }

        const exchangeRate = dto.exchange_rate_used || 1.0;
        // Calculate full current valuation adjustments safely converting floats
        const totalValueInBaseCurrency = (dto.unit_price * parseFloat(asset.quantity)) * exchangeRate;

        return await this.repo.addValuation(assetId, {
            unit_price: dto.unit_price,
            total_value_in_base_currency: totalValueInBaseCurrency,
            exchange_rate_used: exchangeRate
        });
    }

    /**
     * Pulls the user's asset snapshot list
     */
    async listDashboardAssets(userId) {
        return await this.repo.getUserAssetsWithLatestValue(userId);
    }

    async getHistoricalTimeline(userId) {
        return await this.repo.getNetWorthHistory(userId);
    }
}

module.exports = { AssetService };