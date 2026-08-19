// middleware/contextGuard.js
const requireBusinessContext = (req, res, next) => {
    const workspaceType = req.headers['x-workspace-type']; // 'personal' or 'business'
    const businessId = req.headers['x-business-id'];

    if (workspaceType !== 'business' || !businessId) {
        return res.status(403).json({ error: "Access Denied: This feature requires a Business Workspace context." });
    }

    // Attach it to the request object for your controllers to use
    req.businessId = businessId;
    next();
};

module.exports = { requireBusinessContext };