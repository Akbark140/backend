const jwt = require('jsonwebtoken');

jest.mock('../../src/config/index.config', () => ({
  config: {
    JWT_ACCESS_SECRET: 'test-access-secret',
  },
}));

jest.mock('../../src/config/logger.config', () => ({
  logger: { error: jest.fn() },
}));

const { authenticate } = require('../../src/middleware/authorize.middleware');

const signTestToken = () =>
  jwt.sign(
    { sub: 'user-123', email: 'test@example.com', jti: 'jti-1' },
    'test-access-secret',
    { expiresIn: '15m' }
  );

describe('authenticate middleware', () => {
  const next = jest.fn();

  beforeEach(() => {
    next.mockClear();
  });

  it('accepts access token from HttpOnly cookie', () => {
    const token = signTestToken();
    const req = { headers: {}, cookies: { accessToken: token } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({
      id: 'user-123',
      email: 'test@example.com',
      jti: 'jti-1',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('prefers Authorization header when both header and cookie are present', () => {
    const headerToken = signTestToken();
    const cookieToken = jwt.sign(
      { sub: 'other-user', email: 'other@example.com' },
      'test-access-secret',
      { expiresIn: '15m' }
    );

    const req = {
      headers: { authorization: `Bearer ${headerToken}` },
      cookies: { accessToken: cookieToken },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.id).toBe('user-123');
  });

  it('returns 401 when no token is provided', () => {
    const req = { headers: {}, cookies: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access token missing',
    });
  });
});
