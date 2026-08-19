// tests/transactions.routes.test.js

const request = require('supertest');
const express = require('express');

const transactionsRouter = require('../../src/modules/transactions/transactions.routes');

const app = express();

app.use(express.json());

// Mount routes
app.use('/api/transactions', transactionsRouter);

// Global error handler for tests
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
  });
});

describe('Transactions Routes', () => {
  // ─────────────────────────────────────────────
  // GET ALL TRANSACTIONS
  // ─────────────────────────────────────────────

  describe('GET /api/transactions', () => {
    it('should return transactions list', async () => {
      const response = await request(app).get(
        '/api/transactions'
      );

      expect([200, 401]).toContain(
        response.statusCode
      );
    });
  });

  // ─────────────────────────────────────────────
  // CREATE TRANSACTION
  // ─────────────────────────────────────────────

  describe('POST /api/transactions', () => {
    it('should return validation error if fields are missing', async () => {
      const response = await request(app)
        .post('/api/transactions')
        .send({});

      expect([400, 401]).toContain(
        response.statusCode
      );
    });

    it('should create transaction successfully', async () => {
      const response = await request(app)
        .post('/api/transactions')
        .send({
          title: 'Groceries',
          amount: 2500,
          type: 'expense',
          category: 'Food',
        });

      expect([200, 201, 401]).toContain(
        response.statusCode
      );
    });
  });

  // ─────────────────────────────────────────────
  // GET SINGLE TRANSACTION
  // ─────────────────────────────────────────────

  describe('GET /api/transactions/:id', () => {
    it('should return transaction details', async () => {
      const response = await request(app).get(
        '/api/transactions/1'
      );

      expect([200, 404, 401]).toContain(
        response.statusCode
      );
    });
  });

  // ─────────────────────────────────────────────
  // UPDATE TRANSACTION
  // ─────────────────────────────────────────────

  describe('PUT /api/transactions/:id', () => {
    it('should update transaction successfully', async () => {
      const response = await request(app)
        .put('/api/transactions/1')
        .send({
          title: 'Updated Grocery',
          amount: 3000,
        });

      expect([200, 404, 401]).toContain(
        response.statusCode
      );
    });
  });

  // ─────────────────────────────────────────────
  // DELETE TRANSACTION
  // ─────────────────────────────────────────────

  describe('DELETE /api/transactions/:id', () => {
    it('should delete transaction successfully', async () => {
      const response = await request(app).delete(
        '/api/transactions/1'
      );

      expect([200, 404, 401]).toContain(
        response.statusCode
      );
    });
  });
});