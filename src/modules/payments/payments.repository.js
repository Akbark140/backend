const db = require('../../config/db.config'); 

class PaymentRepository {
  /**
   * Records a pending checkout initialization in the main ledger table
   */
  async createTransaction(data) {
    const queryConfig = {
      name: 'insert-core-wallet-ledger',
      text: `
        INSERT INTO public.transactions (
          id, 
          user_id, 
          category_id, 
          type, 
          amount, 
          currency, 
          amount_in_base_currency, 
          exchange_rate_used,
          description, 
          note, 
          idempotency_key,
          date
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE)
        RETURNING *;
      `,
    };

    // Calculate base currency transformation parameters
    // Note: If baseline is PKR, exchange rate is 1.000000000000
    const exchangeRate = data.exchangeRateUsed || 1.000000000000;
    const amountInBaseCurrency = parseFloat(data.amount) * exchangeRate;

    const params = [
      data.id,                     // generated UUIDv4 from service
      data.userId,                 // authenticated customer ID
      data.categoryId || null,     // category link for budget hooks
      data.type || 'expense',      // default transaction type enum
      data.amount,                 // transactional amount value
      data.currency || 'PKR',      // transaction network base currency
      amountInBaseCurrency,        // automated multi-currency calculation field
      exchangeRate,                // fixed numeric scalar precision track
      data.description || `Mobile Checkout initialization via ${data.provider}`,
      data.note || `Mobile tracking details: No: ${data.mobileNumber}, State: PENDING_AUTH`,
      data.idempotencyKey || null  // critical guard against duplicate billing loops
    ];

    const result = await db.query(queryConfig, params);
    return result.rows[0];
  }

  /**
   * Resolves an active ledger transaction by its system UUID primary key
   */
  async findById(id) {
    const queryConfig = {
      name: 'find-ledger-by-uuid',
      text: 'SELECT * FROM public.transactions WHERE id = $1 AND deleted_at IS NULL;',
    };

    const result = await db.query(queryConfig, [id]);
    return result.rows[0];
  }

  /**
   * Resolves a checkout entity using its secure corporate idempotency key 
   */
  async findByIdempotencyKey(key) {
    const queryConfig = {
      name: 'find-ledger-by-idempotency-key',
      text: 'SELECT * FROM public.transactions WHERE idempotency_key = $1 AND deleted_at IS NULL;',
    };

    const result = await db.query(queryConfig, [key]);
    return result.rows[0];
  }

  /**
   * Finalizes the state parameters based on provider gateway handshake results
   */
  async updateCheckoutStatus(id, isSuccess, details = {}) {
    const queryConfig = {
      name: 'finalize-wallet-checkout-state',
      text: `
        UPDATE public.transactions
        SET 
          note = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *;
      `,
    };

    // Generate append notes for internal search visibility
    const statusLabel = isSuccess ? 'SUCCESS' : 'FAILED';
    const referenceTag = details.gatewayReference ? `| Ref: ${details.gatewayReference}` : '';
    const executionError = details.errorMessage ? `| Error: ${details.errorMessage}` : '';
    const noteUpdate = `Checkout Status: ${statusLabel} ${referenceTag} ${executionError}`.trim();

    const params = [noteUpdate, id];
    const result = await db.query(queryConfig, params);
    return result.rows[0];
  }
}

module.exports = new PaymentRepository();