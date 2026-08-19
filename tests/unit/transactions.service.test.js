// tests/unit/transactions.service.test.js
const transactionsService = require('../../src/modules/transactions/transactions.service');

describe('Transactions Service (Unit Tests)', () => {
  const db = require('../../src/config/db.config');
  let testTxnId;
  beforeAll(async () => {
    // Clean and seed
    await db.query("TRUNCATE TABLE transactions RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE TABLE categories RESTART IDENTITY CASCADE");
    
    await db.query(`
      INSERT INTO users (id, name, email, password_hash, currency) 
      VALUES ('00000000-0000-0000-0000-000000000123', 'Test User', 'test@example.com', 'hash', 'USD')
    `);
    await db.query(`
      INSERT INTO categories (id, user_id, name, type) 
      VALUES ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-000000000123', 'Salary', 'income')
    `);
  });

  describe('createTransaction()', () => {
    it('should create income transaction with valid data', async () => {
      const transactionData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'income',
        amount: 5000.00,
        description: 'Monthly Salary',
        category: 'salary',
        date: new Date('2026-06-01'),
      };

      const result = await transactionsService.createTransaction(transactionData);

      expect(result).toBeDefined();
      expect(result.type).toBe('income');
      expect(result.amount).toBe(5000.00);
      expect(result.category).toBe('salary');
    });

    it('should create expense transaction with valid data', async () => {
      const transactionData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'expense',
        amount: 150.00,
        description: 'Grocery Shopping',
        category: 'food',
        date: new Date('2026-06-10'),
      };

      const result = await transactionsService.createTransaction(transactionData);

      expect(result).toBeDefined();
      expect(result.type).toBe('expense');
      expect(result.amount).toBe(150.00);
    });

    it('should reject transaction with missing required fields', async () => {
      const invalidData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'income',
        // missing amount, description, category
      };

      await expect(transactionsService.createTransaction(invalidData)).rejects.toThrow();
    });

    it('should reject transaction with zero amount', async () => {
      const invalidData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'income',
        amount: 0,
        description: 'Test',
        category: 'salary',
      };

      await expect(transactionsService.createTransaction(invalidData)).rejects.toThrow(
        /"amount" must be a finite positive number/
      );
    });

    it('should reject transaction with negative amount', async () => {
      const invalidData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'expense',
        amount: -100.00,
        description: 'Test',
        category: 'food',
      };

      await expect(transactionsService.createTransaction(invalidData)).rejects.toThrow(
        /must be a valid decimal string/
      );
    });

    it('should reject invalid transaction type', async () => {
      const invalidData = {
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'invalid_type',
        amount: 100.00,
        description: 'Test',
        category: 'food',
      };

      await expect(transactionsService.createTransaction(invalidData)).rejects.toThrow(
        'Invalid transaction type'
      );
    });

    
  });

  describe('getTransactionById()', () => {
    
    it('should retrieve transaction by ID', async () => {
      const created = await transactionsService.createTransaction({
        userId: '00000000-0000-0000-0000-000000000123',
        type: 'income', amount: 50, description: 'T'
      });
      testTxnId = created.id;
      const result = await transactionsService.getTransactionById(testTxnId);
      expect(result).toBeDefined();
      expect(result.id).toBe(testTxnId);
    });


    it('should throw error for non-existent transaction', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000999';

      await expect(transactionsService.getTransactionById(nonExistentId)).rejects.toThrow(
        'Transaction not found'
      );
    });
  });

  describe('getTransactionsByUserId()', () => {
    it('should retrieve all transactions for user', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';

      const result = await transactionsService.getTransactionsByUserId(userId);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((txn) => {
        expect(txn.userId).toBe(userId);
      });
    });

    it('should filter transactions by type', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const filters = { type: 'income' };

      const result = await transactionsService.getTransactionsByUserId(userId, filters);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((txn) => {
        expect(txn.type).toBe('income');
      });
    });

    it('should filter transactions by category', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const filters = { category: 'food' };

      const result = await transactionsService.getTransactionsByUserId(userId, filters);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((txn) => {
        expect(txn.category).toBe('food');
      });
    });

    it('should filter transactions by date range', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const filters = {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      };

      const result = await transactionsService.getTransactionsByUserId(userId, filters);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((txn) => {
        const txnDate = new Date(txn.date);
        expect(txnDate >= filters.startDate).toBe(true);
        expect(txnDate <= filters.endDate).toBe(true);
      });
    });
  });

  describe('updateTransaction()', () => {
    it('should update transaction with valid data', async () => {
      const transactionId = testTxnId;
      const updateData = {
        amount: 200.00,
        description: 'Updated description',
      };

      const result = await transactionsService.updateTransaction(transactionId, updateData);

      expect(result).toBeDefined();
      expect(result.amount).toBe(200.00);
      expect(result.description).toBe('Updated description');
    });

    it('should not allow changing transaction type', async () => {
      const transactionId = testTxnId;
      const updateData = {
        type: 'income', // Cannot change type
      };

      await expect(
        transactionsService.updateTransaction(transactionId, updateData)
      ).rejects.toThrow('Cannot change transaction type');
    });

    it('should throw error for non-existent transaction', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000999';
      const updateData = { amount: 100.00 };

      await expect(
        transactionsService.updateTransaction(nonExistentId, updateData)
      ).rejects.toThrow('Transaction not found');
    });
  });

  describe('deleteTransaction()', () => {
    it('should delete transaction successfully', async () => {
      const transactionId = testTxnId;

      const result = await transactionsService.deleteTransaction(transactionId);

      expect(result).toBe(true);
    });

    it('should throw error for non-existent transaction', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000999';

      await expect(transactionsService.deleteTransaction(nonExistentId)).rejects.toThrow(
        'Transaction not found'
      );
    });
  });

  describe('getTransactionStats()', () => {
    it('should calculate income and expense totals', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';

      const result = await transactionsService.getTransactionStats(userId);

      expect(result).toHaveProperty('totalIncome');
      expect(result).toHaveProperty('totalExpenses');
      expect(result).toHaveProperty('netBalance');
      expect(result.netBalance).toBe(result.totalIncome - result.totalExpenses);
    });

    it('should provide stats for date range', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const dateRange = {
        startDate: '2026-01-01',
        endDate: '2026-06-30',
      };

      const result = await transactionsService.getTransactionStats(userId, dateRange);

      expect(result).toHaveProperty('totalIncome');
      expect(result).toHaveProperty('totalExpenses');
      expect(result).toHaveProperty('period');
    });
  });

  describe('getCategoryBreakdown()', () => {
    it('should provide spending breakdown by category', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';

      const result = await transactionsService.getCategoryBreakdown(userId);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((categoryData) => {
        expect(categoryData).toHaveProperty('category');
        expect(categoryData).toHaveProperty('amount');
        expect(categoryData).toHaveProperty('percentage');
      });
    });

    it('should filter category breakdown by transaction type', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const type = 'expense';

      const result = await transactionsService.getCategoryBreakdown(userId, type);

      expect(Array.isArray(result)).toBe(true);
      result.forEach((categoryData) => {
        expect(categoryData.type).toBe(type);
      });
    });
  });

  describe('getDuplicateTransactions()', () => {
    it('should identify duplicate transactions', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';

      const result = await transactionsService.getDuplicateTransactions(userId);

      expect(Array.isArray(result)).toBe(true);
      // Each item should contain transactions that are duplicates
      result.forEach((duplicateGroup) => {
        expect(duplicateGroup.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('bulkCreateTransactions()', () => {
    it('should create multiple transactions', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const transactions = [
        {
          type: 'income',
          amount: 5000,
          description: 'Salary',
          category: 'salary',
          date: new Date('2026-06-01'),
        },
        {
          type: 'expense',
          amount: 100,
          description: 'Groceries',
          category: 'food',
          date: new Date('2026-06-05'),
        },
      ];

      const result = await transactionsService.bulkCreateTransactions(userId, transactions);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle partial failures in bulk create', async () => {
      const userId = '00000000-0000-0000-0000-000000000123';
      const transactions = [
        {
          type: 'income',
          amount: 5000,
          description: 'Salary',
          category: 'salary',
        },
        {
          type: 'invalid',
          amount: -100,
          description: 'Bad transaction',
        },
      ];

      const result = await transactionsService.bulkCreateTransactions(userId, transactions);

      expect(result).toHaveProperty('successful');
      expect(result).toHaveProperty('failed');
    });
  });
});