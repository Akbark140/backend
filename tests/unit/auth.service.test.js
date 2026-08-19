const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const {
  signAccessToken,
  signRefreshToken,
  hashPassword,
  comparePassword,
} = require('../../src/modules/auth/auth.service');

describe('Auth Service (Production Grade)', () => {

  // ─────────────────────────────────────────────
  // PASSWORD HASHING
  // ─────────────────────────────────────────────
  describe('hashPassword()', () => {
    it('should hash password correctly', async () => {
      const password = 'Password123!';

      const hashed = await hashPassword(password);

      expect(hashed).toBeDefined();
      expect(hashed).not.toBe(password);
      expect(hashed.length).toBeGreaterThan(20);
    });
  });

  // ─────────────────────────────────────────────
  // PASSWORD COMPARISON
  // ─────────────────────────────────────────────
  describe('comparePassword()', () => {
    it('should validate correct password', async () => {
      const password = 'Password123!';
      const hashed = await hashPassword(password);

      const result = await comparePassword(password, hashed);

      expect(result).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'Password123!';
      const hashed = await hashPassword(password);

      const result = await comparePassword('WrongPassword', hashed);

      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // ACCESS TOKEN (NEW STRUCTURE)
  // ─────────────────────────────────────────────
  describe('signAccessToken()', () => {
    it('should generate valid JWT access token', () => {
      const userId = 'user-123';
      const email = 'akbar@example.com';

      const token = signAccessToken(userId, email);

      expect(token).toBeDefined();

      const decoded = jwt.decode(token);

      expect(decoded.sub).toBe(userId);
      expect(decoded.email).toBe(email);
      expect(decoded.jti).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────
  // REFRESH TOKEN
  // ─────────────────────────────────────────────
  describe('signRefreshToken()', () => {
    it('should generate valid refresh token', () => {
      const userId = 'user-123';

      const { token } = signRefreshToken(userId);

      expect(token).toBeDefined();

      const decoded = jwt.decode(token);

      expect(decoded.sub).toBe(userId);
      expect(decoded.jti).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────
  // TOKEN SIGNATURE VALIDITY (REAL VERIFICATION)
  // ─────────────────────────────────────────────
  describe('JWT validation', () => {
    it('should validate access token using secret', () => {
      const userId = 'user-123';
      const email = 'akbar@example.com';

      const token = signAccessToken(userId, email);

      const decoded = jwt.verify(
        token,
        process.env.JWT_ACCESS_SECRET
      );

      expect(decoded.sub).toBe(userId);
      expect(decoded.email).toBe(email);
    });

    it('should throw error for invalid token', () => {
      expect(() => {
        jwt.verify('invalid.token.here', process.env.JWT_ACCESS_SECRET);
      }).toThrow();
    });
  });

});