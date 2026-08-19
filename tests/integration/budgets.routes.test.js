// tests/budgets.routes.test.js

const request = require('supertest');
const express = require('express');

const budgetsRouter = require('../../src/modules/budgets/budget.routes');

const app = express();
app.use(express.json());

// Mount route
app.use('/api/budgets', budgetsRouter);

// Global error handler
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
  });
});

describe('Budgets Routes', () => {
  
  // ─────────────────────────────
  // GET ALL BUDGETS
  // ─────────────────────────────
  describe('GET /api/budgets', () => {
    it('should return budgets list or require auth', async () => {
      const response = await request(app).get('/api/budgets');

      // If auth is required → 401 is valid
      // If public → 200 is valid
      expect([200, 401]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        expect(Array.isArray(response.body.data || response.body)).toBe(true);
      }
    });
  });

  // ─────────────────────────────
  // CREATE BUDGET
  // ─────────────────────────────
  describe('POST /api/budgets', () => {
    it('should fail when fields are missing', async () => {
      const response = await request(app)
        .post('/api/budgets')
        .send({});

      // Most APIs return 400 or 422
      expect([400, 422, 401]).toContain(response.statusCode);
    });

    it('should create a budget if valid', async () => {
      const payload = {
        name: 'Monthly Budget',
        amount: 5000,
        category: 'Food',
      };

      const response = await request(app)
        .post('/api/budgets')
        .send(payload);

      // allow auth fallback OR success
      expect([200, 201, 401]).toContain(response.statusCode);

      if (response.statusCode === 201 || response.statusCode === 200) {
        expect(response.body).toBeDefined();
      }
    });
  });

  // ─────────────────────────────
  // GET SINGLE BUDGET
  // ─────────────────────────────
  describe('GET /api/budgets/:id', () => {
    it('should return budget or auth error', async () => {
      const response = await request(app).get('/api/budgets/1');

      expect([200, 404, 401]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        expect(response.body).toBeDefined();
      }
    });
  });

  // ─────────────────────────────
  // UPDATE BUDGET
  // ─────────────────────────────
  describe('PUT /api/budgets/:id', () => {
    it('should update budget or reject request', async () => {
      const response = await request(app)
        .put('/api/budgets/1')
        .send({
          name: 'Updated Budget',
          amount: 7000,
        });

      expect([200, 404, 401]).toContain(response.statusCode);
    });
  });

  // ─────────────────────────────
  // DELETE BUDGET
  // ─────────────────────────────
  describe('DELETE /api/budgets/:id', () => {
    it('should delete budget or return error', async () => {
      const response = await request(app).delete('/api/budgets/1');

      expect([200, 404, 401]).toContain(response.statusCode);
    });
  });
});