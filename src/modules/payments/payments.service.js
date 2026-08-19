const crypto = require('crypto');
const axios = require('axios');
const paymentRepository = require('./payments.repository');

class PaymentService {
  _generateTimestamp(offsetMs = 0) {
    return new Date(Date.now() + offsetMs)
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14);
  }

  async processEasyPaisa(amount, mobileNumber, metadata) {
    const { userId, idempotencyKey, categoryId } = metadata;
    const storeId = process.env.EASYPAISA_STORE_ID;
    const secretKey = process.env.EASYPAISA_SECRET_KEY;
    
    // Generate system level IDs
    const transactionId = crypto.randomUUID(); 
    const orderId = `EP-${Date.now()}`; // Unique provider reference
    const timestamp = this._generateTimestamp();

    // 1. Guard against double execution loops using your idempotency layer
    if (idempotencyKey) {
      const existing = await paymentRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return { status: 'DUPLICATE_REQUEST', orderId: existing.idempotency_key, message: 'Transaction bypass triggered.' };
    }

    // 2. Log initialization footprint inside the public ledger
    await paymentRepository.createTransaction({
      id: transactionId,
      userId,
      categoryId,
      type: 'expense',
      amount,
      currency: 'PKR',
      exchangeRateUsed: 1.000000000000, // PKR is the baseline scale for mobile wallets
      description: `EasyPaisa Checkout to account ${mobileNumber}`,
      idempotencyKey,
      provider: 'EASYPAISA',
      mobileNumber
    });

    const hashString = `amount=${amount}&orderId=${orderId}&storeId=${storeId}&transactionType=MA&timeStamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', secretKey).update(hashString).digest('hex');

    try {
      const response = await axios.post(process.env.EASYPAISA_API_URL, {
        storeId, orderId, transactionAmount: amount, mobileAccountNo: mobileNumber,
        transactionType: 'MA', timeStamp: timestamp, encryptedSignature: signature
      }, { timeout: 10000 });
      
      if (response.data?.responseCode !== '0000') {
        const errorMsg = response.data?.responseDesc || 'EasyPaisa checkout initialization declined.';
        await paymentRepository.updateCheckoutStatus(transactionId, false, { errorMessage: errorMsg });
        throw new Error(errorMsg);
      }

      return { status: 'PENDING_USER_PIN', transactionId, message: 'USSD prompt dispatched.' };
    } catch (error) {
      await paymentRepository.updateCheckoutStatus(transactionId, false, { errorMessage: error.message });
      throw error;
    }
  }

  async processJazzCash(amount, mobileNumber, metadata) {
    const { userId, idempotencyKey, categoryId } = metadata;
    const merchantId = process.env.JAZZCASH_MERCHANT_ID;
    const password = process.env.JAZZCASH_PASSWORD;
    const integritySalt = process.env.JAZZCASH_INTEGRITY_SALT;
    
    const transactionId = crypto.randomUUID();
    const orderId = `JC-${Date.now()}`;
    const expiryTimestamp = this._generateTimestamp(3600000); 

    if (idempotencyKey) {
      const existing = await paymentRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return { status: 'DUPLICATE_REQUEST', orderId: existing.idempotency_key };
    }

    await paymentRepository.createTransaction({
      id: transactionId, userId, categoryId, type: 'expense', amount, currency: 'PKR',
      exchangeRateUsed: 1.000000000000, description: `JazzCash Checkout to account ${mobileNumber}`,
      idempotencyKey, provider: 'JAZZCASH', mobileNumber
    });

    const sortedFields = [expiryTimestamp, amount, orderId, merchantId, password, 'PKR', 'MWALLET', '0000'].join('&');
    const signature = crypto.createHmac('sha256', integritySalt).update(sortedFields).digest('hex');

    try {
      const response = await axios.post(process.env.JAZZCASH_API_URL, {
        pp_Version: '1.1', pp_TxnType: 'MWALLET', pp_Language: 'EN', pp_MerchantID: merchantId,
        pp_Password: password, pp_TxnRefNo: orderId, pp_Amount: Math.round(parseFloat(amount) * 100).toString(), 
        pp_TxnCurrency: 'PKR', pp_TxnDateTime: expiryTimestamp, pp_MobileNumber: mobileNumber, pp_SecureHash: signature,
      }, { timeout: 10000 });

      if (response.data?.pp_ResponseCode !== '000') {
        const errorMsg = response.data?.pp_ResponseMessage || 'JazzCash checkout initialization declined.';
        await paymentRepository.updateCheckoutStatus(transactionId, false, { errorMessage: errorMsg });
        throw new Error(errorMsg);
      }

      await paymentRepository.updateCheckoutStatus(transactionId, true, { gatewayReference: response.data?.pp_RetreivalReferenceNo });
      return { status: 'SUCCESS', transactionId, message: 'JazzCash debit process completed.' };
    } catch (error) {
      await paymentRepository.updateCheckoutStatus(transactionId, false, { errorMessage: error.message });
      throw error;
    }
  }
}

module.exports = new PaymentService();