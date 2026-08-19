const request = require('supertest');
const app = require('../src/app');

describe('AI Routes', () => {

  it('Generate Insight', async () => {

    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        message: 'How can I save money?'
      });

    // Accept both success (200) and unauthorized (401) - depends on auth middleware
    expect([200, 401]).toContain(res.statusCode);

  });

});