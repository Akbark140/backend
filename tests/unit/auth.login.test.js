jest.mock('../../src/config/db.config', () => ({
  query: jest.fn(),
  withTransaction: jest.fn((cb) => cb({ query: jest.fn() })),
}));

jest.mock('../../src/config/redis.config', () => ({
  blacklistToken: jest.fn(),
  isTokenBlacklisted: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../../src/config/db.config');
const { UnauthorizedError } = require('../../src/shared/AppError');
const authService = require('../../src/modules/auth/auth.service');

describe('auth.service login()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when the email does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      authService.login({ email: 'missing@example.com', password: 'Password1!' })
    ).rejects.toThrow(new UnauthorizedError('Invalid email or password'));
  });

  it('rejects OAuth-only accounts without a password hash', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'oauth@example.com',
        password_hash: null,
        is_active: true,
      }],
    });

    await expect(
      authService.login({ email: 'oauth@example.com', password: 'Password1!' })
    ).rejects.toThrow('This account uses social login');
  });

  it('authenticates when email casing differs but password matches', async () => {
    const passwordHash = await bcrypt.hash('Password1!', 12);

    query.mockResolvedValueOnce({
      rows: [{
        id: 'user-1',
        email: 'farhan.link1998@gmail.com',
        password_hash: passwordHash,
        is_active: true,
      }],
    });

    withTransaction.mockImplementationOnce(async (cb) => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      return cb(client);
    });

    const tokens = await authService.login({
      email: 'Farhan.Link1998@Gmail.com',
      password: 'Password1!',
    });

    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(email)'),
      ['farhan.link1998@gmail.com']
    );
  });
});
