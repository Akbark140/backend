// asset.controller.js
const { createAssetSchema, updateValuationSchema } = require('./asset.schema.js');

class AssetController {
    constructor(assetService) {
        this.service = assetService;
    }

    createAsset = async (req, res, next) => {
        try {
            const userId = req.user.id; // Assigned upstream by your Authentication Guard middleware

            // Strict Zod Parse check
            const validatedData = createAssetSchema.parse(req.body);

            const asset = await this.service.createNewAsset(userId, validatedData);
            return res.status(201).json({ success: true, data: asset });
        } catch (error) {
            if (error.name === 'ZodError') {
                return res.status(400).json({ success: false, errors: error.errors });
            }
            next(error); // Passes system layer execution downstream to your express error handler
        }
    };

    updateValuation = async (req, res, next) => {
        try {
            const userId = req.user.id;
            const { id } = req.params;

            const validatedData = updateValuationSchema.parse(req.body);

            const valuation = await this.service.recordNewValuation(userId, id, validatedData);
            return res.status(200).json({ success: true, data: valuation });
        } catch (error) {
            if (error.name === 'ZodError') {
                return res.status(400).json({ success: false, errors: error.errors });
            }
            if (error.statusCode === 404) {
                return res.status(404).json({ success: false, error: error.message });
            }
            next(error);
        }
    };

    getAssetsSummary = async (req, res, next) => {
        try {
            const userId = req.user.id;
            const data = await this.service.listDashboardAssets(userId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    };

    getHistory = async (req, res, next) => {
        try {
            const userId = req.user.id;
            const data = await this.service.getHistoricalTimeline(userId);
            return res.status(200).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    };
}

module.exports = { AssetController };