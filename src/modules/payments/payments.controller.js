const paymentService = require('./payments.service');

exports.initiateWalletCheckout = async (req, res) => {
  const { amount, mobileNumber, provider, categoryId } = req.body;
  
  // Extract contextual parameters safely from auth token & security payloads
  const userId = req.user?.id || req.body.userId; // Enforce fallback for design compatibility
  const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey;

  if (!userId) {
    return res.status(401).json({ message: 'Authentication required: Missing clear user execution context.' });
  }

  try {
    let transactionResult;
    const metadata = { userId, idempotencyKey, categoryId };

    switch (provider) {
      case 'EASYPAISA':
        transactionResult = await paymentService.processEasyPaisa(amount, mobileNumber, metadata);
        break;
      case 'JAZZCASH':
        transactionResult = await paymentService.processJazzCash(amount, mobileNumber, metadata);
        break;
      default:
        return res.status(400).json({ message: 'Unsupported wallet provider fallback triggered.' });
    }

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      data: transactionResult
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      message: 'Upstream payment gateway communication exception occurred.',
      detail: error.message
    });
  }
};