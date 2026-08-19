/**
 * Authentication & Identity Service
 * * Core Business Logic Layer. Contains raw application rules for authentication, 
 * cryptography operations, user onboarding data seeding, and secure state storage.
 * Completely independent of HTTP routing engines.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { config } = require('../../config/index.config');
const { query, withTransaction } = require('../../config/db.config');
const { blacklistToken, isTokenBlacklisted } = require('../../config/redis.config');
const { BCRYPT_ROUNDS, DEFAULT_CATEGORIES } = require('../../shared/constants');
const { ConflictError, UnauthorizedError } = require('../../shared/AppError');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../../config/mailer.config');
const crypto = require('crypto');

// ── Token helpers ─────────────────────────────────────────────────────────────

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * Looks up a user by email using a case-insensitive match.
 */
async function findUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);

  const result = await query(
    `SELECT id, email, password_hash, is_active
     FROM users
     WHERE LOWER(email) = $1`,
    [normalizedEmail]
  );

  return result.rows?.[0] ?? result[0] ?? null;
}

/**
 * Generates a short-lived JSON Web Token for API resource access
 * @param {string} userId 
 * @param {string} email 
 * @returns {string} Signed JWT Access Token
 */
function signAccessToken(userId, email) {
  const payload = {
    sub: userId,       // Subject claim mapping the token to the specific system user
    email,
    jti: uuidv4(),     // JWT ID: Unique identifier for tracking individual token issuances
  };

  return jwt.sign(payload, config.JWT_ACCESS_SECRET, {
    expiresIn: '15m',  // Explicitly set to 15 minutes to match library specifications
  });
}

/**
 * Generates a long-lived cryptographically trackable token to request fresh access tokens
 * @param {string} userId 
 * @returns {Object} { token: String, jti: String } Generated token and its unique reference ID
 */
function signRefreshToken(userId) {
  const jti = uuidv4(); // Generate unique tracking token signature id

  const token = jwt.sign(
    {
      sub: userId,
      jti,
    },
    config.JWT_REFRESH_SECRET,
    {
      expiresIn: '7d', // Explicitly set to 7 days to match library specifications
    }
  );

  return { token, jti };
}

/**
 * Persists metadata and cryptographically hashed signatures of active refresh tokens
 * @param {Object} client PostgreSQL Transaction client connection instance
 * @param {string} userId 
 * @param {string} jti Token tracking identifier mapped as the Primary Key
 * @param {string} tokenHash Hashed representation of the token string to prevent DB compromise exposure
 */
async function storeRefreshToken(client, userId, jti, tokenHash) {
  // Enforces a strict 7-day expiration timestamp on structural tokens
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await client.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [jti, userId, tokenHash, expiresAt]
  );
}

// ── Public service methods ────────────────────────────────────────────────────

/**
 * Onboards a brand new user using a strict rollback-safe sequence
 * @param {Object} input Formatted user registration fields
 * @returns {Promise<Object>} Object containing fresh accessToken and refreshToken
 */
async function register(input) {
  const email = normalizeEmail(input.email);

  // 1. Run database operations inside the transaction
  const registrationData = await withTransaction(async (client) => {

    // Guard against email reuse (case-insensitive)
    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      throw new ConflictError('An account with this email already exists');
    }

    // Hash raw credentials using secure computing rounds
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const userId = uuidv4();

    // Generate verification token properties
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Persist structural account properties
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, currency, verification_token, verification_token_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, input.name, email, passwordHash, input.currency, verificationToken, verificationExpiresAt]
    );

    // Seed user profile defaults
    for (const cat of DEFAULT_CATEGORIES) {
      await client.query(
        `INSERT INTO categories (id, user_id, name, icon, color, type, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [uuidv4(), userId, cat.name, cat.icon, cat.color, cat.type]
      );
    }

    // Return only the values needed for tokens and emails out of the transaction
    return { userId, verificationToken };
  }); //  Transaction safely closes and commits here!

  const { userId, verificationToken } = registrationData;

  // 2. Network and Token signing operations run safely outside the transaction block
  try {
    // If the SMTP provider is slow, it no longer delays or hangs database rows
    await sendVerificationEmail(email, verificationToken);
  } catch (emailError) {
    // Log the error but don't crash registration; user can request a resend later
    console.error(`⚠️ Failed to send verification email to ${email}:`, emailError);
  }

  // Build and sign authorization session state
  const accessToken = signAccessToken(userId, email);
  const { token: refreshToken, jti } = signRefreshToken(userId);

  const tokenHash = await bcrypt.hash(refreshToken, 10);

  // Store the refresh token using your standard query connection pool
  await withTransaction(async (client) => {
    await storeRefreshToken(client, userId, jti, tokenHash);
  });

  return { accessToken, refreshToken };
}

/**
 * Retrieves the profile projection of the authenticated actor
 * @param {string} userId 
 * @returns {Promise<Object|null>} Stripped non-sensitive user profile or null
 */
async function getMe(userId) {
  const result = await query(
    'SELECT id, name, email, currency, avatar_url, created_at FROM users WHERE id = $1',
    [userId]
  );
  const user = result.rows ? result.rows[0] : result[0];
  return user || null;
}

/**
 * Verifies standard login parameters and starts a fresh valid user session
 * @param {Object} input Contains plaintext login credentials
 * @returns {Promise<Object>} Fresh token pair
 */
async function login(input) {
  const email = normalizeEmail(input.email);
  const password = input.password;

  if (!email || !password) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = await findUserByEmail(email);

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (user.is_active === false) {
    throw new UnauthorizedError('This account has been deactivated. Please contact support.');
  }

  if (!user.password_hash) {
    throw new UnauthorizedError(
      'This account uses social login. Please sign in with Google or GitHub.'
    );
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Issue tokens and save tracking references inside an isolated database operation block
  return withTransaction(async (client) => {
    const accessToken = signAccessToken(user.id, user.email);
    const { token: refreshToken, jti } = signRefreshToken(user.id);

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await storeRefreshToken(client, user.id, jti, tokenHash);

    return { accessToken, refreshToken };
  });
}

/**
 * Processes automated token rotation logic to extend valid authorization
 * Includes a security block protecting against replay attacks
 * @param {string} rawRefreshToken 
 * @returns {Promise<Object>} Brand new token cycle pairs
 */
async function refresh(rawRefreshToken) {
  let payload;

  // 1. Verify token authenticity and signature expiration
  try {
    payload = jwt.verify(rawRefreshToken, config.JWT_REFRESH_SECRET);
  } catch (err) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  return withTransaction(async (client) => {
    // 3. Confirm target database references match valid authorization scopes
    const rows = await client.query(
      `SELECT token_hash, user_id, revoked_at FROM refresh_tokens
       WHERE id = $1 AND expires_at > NOW()`,
      [payload.jti]
    );

    const stored = rows.rows[0];

    if (!stored) {
      throw new UnauthorizedError('Refresh token not found or expired');
    }

    // Goal 2: Tolerate concurrent requests within a brief clock-skew window (15s)
    if (stored.revoked_at) {
      const revokedTime = new Date(stored.revoked_at).getTime();
      if (Date.now() - revokedTime > 15000) {
        throw new UnauthorizedError('Refresh token has been revoked');
      }
    } else {
      // 2. Query in-memory distributed engine cache to verify token state hasn't been blocked
      if (await isTokenBlacklisted(payload.jti)) {
        throw new UnauthorizedError('Refresh token has been revoked');
      }
    }

    // 4. Double check token authenticity against database string verification hashes
    const valid = await bcrypt.compare(rawRefreshToken, stored.token_hash);
    if (!valid) {
      throw new UnauthorizedError('Refresh token mismatch');
    }

    // 5. Mark used token as revoked to execute single-use token rotation patterns
    if (!stored.revoked_at) {
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
        [payload.jti]
      );

      // 6. Blacklist token globally inside cache memory to prevent session hijacking replays
      await blacklistToken(payload.jti, 7 * 24 * 60 * 60);
    }

    const userRows = await client.query(
      'SELECT email FROM users WHERE id = $1',
      [stored.user_id]
    );
    const email = userRows.rows[0]?.email;

    // 7. Re-issue clean, valid session sets
    const accessToken = signAccessToken(stored.user_id, email);
    const { token: newRefreshToken, jti: newJti } = signRefreshToken(stored.user_id);

    const newHash = await bcrypt.hash(newRefreshToken, 10);
    await storeRefreshToken(client, stored.user_id, newJti, newHash);

    return { accessToken, refreshToken: newRefreshToken };
  });
}

/**
 * Completely invalidates current user tracking sessions
 * @param {string} accessToken Raw Authorization Header token string 
 * @param {string} refreshToken Raw client-side tracking state payload token string
 */
async function logout(accessToken, refreshToken) {
  // 1. Immediately drop access tokens out of processing scopes via localized cache expiration rules
  try {
    const payload = jwt.decode(accessToken);

    if (payload && payload.jti && payload.exp) {
      // Calculate remaining token life window down to exact second metrics
      const ttl = payload.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await blacklistToken(payload.jti, ttl);
      }
    }
  } catch (err) {
    // Fail silently on intercept anomalies to maintain systemic runtime uptime integrity
  }

  // 2. Permanently disable structural backend refresh token authorizations
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, config.JWT_REFRESH_SECRET);

      await query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
        [payload.jti]
      );

      await blacklistToken(payload.jti, 7 * 24 * 60 * 60);
    } catch (err) {
      // Fail silently on formatting issues or expired states
    }
  }
}

/**
 * Handles identity mapping strategies derived from federated authentication handshakes (OAuth)
 * Performs dynamic account linking or creates on-the-fly user profiles
 * @param {Object} profile Normalized target metadata attributes passed down by passport strategy engines
 * @returns {Promise<Object>} Active validation tokens
 */
async function findOrCreateOAuthUser(profile) {
  return withTransaction(async (client) => {
    // 1. Query for an existing OAuth provider match mapping to this provider and ID combo
    const linkRows = await client.query(
      `SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_id = $2`,
      [profile.provider, profile.providerId]
    );

    let userId;

    if (linkRows.rows.length > 0) {
      // User has authenticated via this provider before
      userId = linkRows.rows[0].user_id;
    } else {
      // 2. No direct OAuth link. Look for an existing account registered with the same email
      const emailRows = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [profile.email]
      );

      if (emailRows.rows.length > 0) {
        // Account linking scenario: User exists but is signing in via OAuth for the first time
        userId = emailRows.rows[0].id;
      } else {
        // 3. Complete net-new profile provision flow
        userId = uuidv4();

        // Baseline currency configuration uses PKR
        await client.query(
          `INSERT INTO users (id, name, email, avatar_url, currency)
           VALUES ($1, $2, $3, $4, 'PKR')`,
          [
            userId,
            profile.name,
            profile.email,
            profile.avatarUrl || null,
          ]
        );

        // Seed basic operational state metadata
        for (const cat of DEFAULT_CATEGORIES) {
          await client.query(
            `INSERT INTO categories (id, user_id, name, icon, color, type, is_default)
             VALUES ($1, $2, $3, $4, $5, $6, true)`,
            [uuidv4(), userId, cat.name, cat.icon, cat.color, cat.type]
          );
        }
      }
    }

    // 4. Upsert/Update the OAuth account details along with Google OAuth API credential parameters
    // Using COALESCE for the refresh token guarantees we don't nullify a valid token on subsequent logins
    await client.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_id, avatar_url, google_access_token, google_refresh_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_id) 
       DO UPDATE SET 
         avatar_url = EXCLUDED.avatar_url,
         google_access_token = EXCLUDED.google_access_token,
         google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, oauth_accounts.google_refresh_token),
         updated_at = NOW()`,
      [
        userId,
        profile.provider,
        profile.providerId,
        profile.avatarUrl || null,
        profile.googleAccessToken || null,
        profile.googleRefreshToken || null
      ]
    );

    // 5. Finalize setup by fetching profile state properties to issue token pairs
    const userRows = await client.query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );

    const email = userRows.rows[0].email;

    const accessToken = signAccessToken(userId, email);
    const { token: refreshToken, jti } = signRefreshToken(userId);

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await storeRefreshToken(client, userId, jti, tokenHash);

    return { accessToken, refreshToken };
  });
}

async function verifyEmail(token) {
  const result = await query(
    `SELECT id FROM users 
     WHERE verification_token = $1 
     AND verification_token_expires_at > NOW()
     AND is_verified = false`,
    [token]
  );

  const user = result[0];
  if (!user) throw new UnauthorizedError('Invalid or expired verification token.');

  await query(
    `UPDATE users 
     SET is_verified = true, verification_token = NULL, verification_token_expires_at = NULL 
     WHERE id = $1`,
    [user.id]
  );
}

async function resendVerification(email) {
  // 1. Find user
  const result = await query(
    'SELECT id, is_verified FROM users WHERE email = $1',
    [email]
  );

  const user = result[0];

  if (!user) throw new ConflictError('No account found with that email.');
  if (user.is_verified) throw new ConflictError('Email is already verified.');

  // 2. Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  // 3. Store token in DB
  await query(
    `UPDATE users 
     SET verification_token = $1, verification_token_expires_at = $2 
     WHERE email = $3`,
    [token, expiresAt, email]
  );

  // 4. Send the email
  await sendVerificationEmail(email, token);
}

async function forgotPassword(email) {
  const result = await query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  // Don't reveal whether the email exists or not
  if (!result[0]) return;

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await query(
    `UPDATE users 
     SET verification_token = $1, verification_token_expires_at = $2 
     WHERE email = $3`,
    [code, expiresAt, email]
  );

  await sendPasswordResetEmail(email, code);
}

async function resetPassword(code, newPassword) {
  const result = await query(
    `SELECT id FROM users 
     WHERE verification_token = $1 
     AND verification_token_expires_at > NOW()`,
    [code]
  );

  const user = result[0];
  if (!user) throw new UnauthorizedError('Invalid or expired reset code.');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await query(
    `UPDATE users 
     SET password_hash = $1, verification_token = NULL, verification_token_expires_at = NULL 
     WHERE id = $2`,
    [passwordHash, user.id]
  );
}


const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const comparePassword = async (password, hashed) => {
  return bcrypt.compare(password, hashed);
};

const generateAccessToken = (user) => {
  const payload = {
    sub: user.id || user.sub,
    email: user.email,
  };
  return jwt.sign(payload, config.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET, {
    expiresIn: '15m',
  });
};

const generateRefreshToken = (user) => {
  const payload = {
    sub: user.id || user.sub,
  };
  return jwt.sign(payload, config.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET, {
    expiresIn: '7d',
  });
};

const generateTokens = (user) => {
  const payload = {
    sub: user.id || user.sub,
    email: user.email,
  };
  const accessToken = jwt.sign(payload, config.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET || 'access_secret', {
    expiresIn: '15m',
  });
  const refreshToken = jwt.sign(payload, config.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET || 'refresh_secret', {
    expiresIn: '7d',
  });
  return { accessToken, refreshToken };
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, config.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET);
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, config.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET);
};


// ── exports ────────────────────────────────────────────────────────────────────
module.exports = {
  getMe,
  register,
  login,
  refresh,
  logout,
  findOrCreateOAuthUser,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
};

// Expose helper functions used by unit tests and other modules
module.exports.hashPassword = hashPassword;
module.exports.comparePassword = comparePassword;
module.exports.signAccessToken = signAccessToken;
module.exports.signRefreshToken = signRefreshToken;
module.exports.generateAccessToken = generateAccessToken;
module.exports.generateRefreshToken = generateRefreshToken;
module.exports.generateTokens = generateTokens;
module.exports.verifyAccessToken = verifyAccessToken;
module.exports.verifyRefreshToken = verifyRefreshToken;