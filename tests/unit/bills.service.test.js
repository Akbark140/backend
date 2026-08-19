const billsService = require('../../src/modules/bills/bills.service');
const repo = require('../../src/modules/bills/bills.repository');
const { AppError } = require('../../src/shared/AppError');
const { query } = require('../../src/config/db.config');

describe('Bills Service (Unit Tests)', () => {
  const userId = '123e4567-e89b-12d3-a456-426614174000';

  beforeAll(async () => {
    await query(`
      INSERT INTO users (id, name, email, password_hash)
      VALUES ($1, 'Test User', 'testuser_bills@example.com', 'hash')
      ON CONFLICT (id) DO NOTHING
    `, [userId]);
  });

  beforeEach(async () => {
    // Clear the repository before each test
    await repo.clearAll();
  });

  describe('createBill()', () => {
    it('should create a bill with valid data', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
        currency: 'USD',
        recurrence: 'monthly',
      };

      const result = await billsService.createBill(userId, billData);

      expect(result).toBeDefined();
      expect(result.name).toBe('Electricity Bill');
      expect(result.amount).toBe(150.00);
    });

    it('should reject bill creation with missing required fields', async () => {
      const invalidData = {
        // missing name and amount
      };

      await expect(billsService.createBill(userId, invalidData)).rejects.toThrow();
    });

    it('should reject bill with missing amount', async () => {
      const invalidData = {
        name: 'Gas Bill',
        due_date: '2026-07-15',
      };

      await expect(billsService.createBill(userId, invalidData)).rejects.toThrow();
    });

    it('should reject bill with missing due date', async () => {
      const invalidData = {
        name: 'Internet Bill',
        amount: 75.00,
      };

      await expect(billsService.createBill(userId, invalidData)).rejects.toThrow();
    });
  });

  describe('getBillById()', () => {
    it('should retrieve bill by ID', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      const result = await billsService.getBillById(created.id, userId);

      expect(result).toBeDefined();
      expect(result.id).toBe(created.id);
      expect(result.name).toBe('Electricity Bill');
    });

    it('should throw error for non-existent bill', async () => {
      await expect(
        billsService.getBillById('00000000-0000-0000-0000-000000000000', userId)
      ).rejects.toThrow('Bill not found');
    });
  });

  describe('getAllBills()', () => {
    it('should retrieve all bills for a user', async () => {
      const bill1 = await billsService.createBill(userId, {
        name: 'Bill 1',
        amount: 100,
        due_date: '2026-07-15',
      });

      const bill2 = await billsService.createBill(userId, {
        name: 'Bill 2',
        amount: 200,
        due_date: '2026-08-15',
      });

      const result = await billsService.getAllBills(userId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result.map(b => b.id)).toContain(bill1.id);
      expect(result.map(b => b.id)).toContain(bill2.id);
    });

    it('should return empty array for user with no bills', async () => {
      const result = await billsService.getAllBills(userId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('updateBill()', () => {
    it('should update bill with valid data', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      const updateData = {
        amount: 200.00,
        name: 'Updated Electricity Bill',
      };

      const result = await billsService.updateBill(created.id, userId, updateData);

      expect(result).toBeDefined();
      expect(result.amount).toBe(200.00);
      expect(result.name).toBe('Updated Electricity Bill');
    });

    it('should throw error for non-existent bill update', async () => {
      const updateData = { amount: 200.00 };

      await expect(
        billsService.updateBill('00000000-0000-0000-0000-000000000000', userId, updateData)
      ).rejects.toThrow('Bill not found');
    });
  });

  describe('deleteBill()', () => {
    it('should delete bill successfully', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      const result = await billsService.deleteBill(created.id, userId);

      expect(result.deleted).toBe(true);

      // Verify it's actually deleted
      await expect(
        billsService.getBillById(created.id, userId)
      ).rejects.toThrow('Bill not found');
    });

    it('should throw error when deleting non-existent bill', async () => {
      await expect(
        billsService.deleteBill('00000000-0000-0000-0000-000000000000', userId)
      ).rejects.toThrow('Bill not found');
    });
  });

  describe('getOverdueBills()', () => {
    it('should retrieve overdue bills for user', async () => {
      // Create an overdue bill
      const overdueBill = await billsService.createBill(userId, {
        name: 'Overdue Bill',
        amount: 100,
        due_date: '2020-01-01', // Past date
      });

      // Create an upcoming bill
      const upcomingBill = await billsService.createBill(userId, {
        name: 'Upcoming Bill',
        amount: 200,
        due_date: '2026-12-31', // Future date
      });

      const result = await billsService.getOverdueBills(userId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe(overdueBill.id);
      expect(result[0].status).toBe('overdue');
    });
  });

  describe('getUpcomingBills()', () => {
    it('should retrieve upcoming bills for user', async () => {
      // Create overdue bill
      await billsService.createBill(userId, {
        name: 'Overdue Bill',
        amount: 100,
        due_date: '2020-01-01',
      });

      // Create upcoming bills
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const nextTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const upcoming1 = await billsService.createBill(userId, {
        name: 'Upcoming Bill 1',
        amount: 200,
        due_date: nextWeek,
      });

      const upcoming2 = await billsService.createBill(userId, {
        name: 'Upcoming Bill 2',
        amount: 300,
        due_date: nextTwoWeeks,
      });

      const result = await billsService.getUpcomingBills(userId);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe(upcoming1.id);
      expect(result[1].id).toBe(upcoming2.id);
    });
  });

  describe('markAsPaid()', () => {
    it('should mark bill as paid', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      const result = await billsService.markAsPaid(created.id, userId);

      expect(result.status).toBe('paid');
    });

    it('should not allow marking already paid bill as paid', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      await billsService.markAsPaid(created.id, userId);

      await expect(
        billsService.markAsPaid(created.id, userId)
      ).rejects.toThrow('Bill is already marked as paid');
    });

    it('should auto-create next recurring bill', async () => {
      const billData = {
        name: 'Monthly Bill',
        amount: 100,
        due_date: '2026-07-15',
        recurrence: 'monthly',
      };

      const created = await billsService.createBill(userId, billData);
      await billsService.markAsPaid(created.id, userId);

      const allBills = await billsService.getAllBills(userId);

      expect(allBills.length).toBe(2);
      const nextBill = allBills.find(b => b.id !== created.id);
      expect(nextBill.name).toBe('Monthly Bill');
    });
  });

  describe('markAsUnpaid()', () => {
    it('should mark paid bill as unpaid', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);
      await billsService.markAsPaid(created.id, userId);
      const result = await billsService.markAsUnpaid(created.id, userId);

      expect(result.status).toBe('unpaid');
    });

    it('should not allow marking unpaid bill as unpaid', async () => {
      const billData = {
        name: 'Electricity Bill',
        amount: 150.00,
        due_date: '2026-07-15',
      };

      const created = await billsService.createBill(userId, billData);

      await expect(
        billsService.markAsUnpaid(created.id, userId)
      ).rejects.toThrow('Bill is not marked as paid');
    });
  });
});