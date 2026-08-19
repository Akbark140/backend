require('dotenv').config();
const { Router } = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: GitHubStrategy } = require('passport-github2');
const { config } = require('../../config/index.config');
const { authRateLimiter } = require('../../middleware/rateLimiter.middleware');
const {validate} = require('../../middleware/validate.middleware');
const { authenticate } = require('../../middleware/authorize.middleware');
const {registerSchema,  loginSchema,  refreshSchema } = require('./auth.schema');
const controller = require('./auth.controller');
const { findOrCreateOAuthUser } = require('./auth.service');

const router = Router();

const backendBase = "https://lite-generator-acm-physics.trycloudflare.com"

// ── Passport: Google ───────────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      callbackURL: `${backendBase}/api/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // ── CHANGED: Pass the calendar tokens into your database service ──
        const tokens = await findOrCreateOAuthUser({
          provider: 'google',
          providerId: profile.id,
          email: profile.emails?.[0]?.value || '',
          name: profile.displayName,
          avatarUrl: profile.photos?.[0]?.value,
          // Add these fields so you can update them in your database
          googleAccessToken: accessToken,
          googleRefreshToken: refreshToken, 
        });

        done(null, tokens);
      } catch (err) {
        done(err);
      }
    }
  )
);

// ── Passport: GitHub ───────────────────────────────────────────────
passport.use(
  new GitHubStrategy(
    {
      clientID: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      callbackURL: `${backendBase}/api/auth/github/callback`,
      scope: ['user:email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email =
          profile.emails?.find((e) => e.primary)?.value ||
          profile.emails?.[0]?.value ||
          '';

        const tokens = await findOrCreateOAuthUser({
          provider: 'github',
          providerId: profile.id,
          email,
          name: profile.displayName || profile.username,
          avatarUrl: profile.photos?.[0]?.value,
        });

        done(null, tokens);
      } catch (err) {
        done(err);
      }
    }
  )
);

// ── Auth Routes ────────────────────────────────────────────────────

router.get('/me',        authenticate,                               controller.me); 

// ==== Email/password auth =========================
router.post('/register', authRateLimiter, validate(registerSchema), controller.register);
router.post('/login', authRateLimiter, validate(loginSchema), controller.login);
router.post('/refresh', authRateLimiter, validate(refreshSchema), controller.refresh);
router.post('/logout', authenticate, controller.logout);

// ==== verification ====================
router.get('/verify-email', authRateLimiter, controller.verifyEmail);

// ===== resend-verification link ========================
router.post('/resend-verification', authRateLimiter, controller.resendVerification);

// ===== forget-password ============
router.post('/forgot-password', authRateLimiter, controller.forgotPassword);

// ====== reset-password ==================
router.post('/reset-password',  authRateLimiter, controller.resetPassword);

// Google OAuth
router.get(
  '/google',
  authRateLimiter,
  // ── CHANGED: Added calendar scopes & forced an offline access type to obtain a refreshToken ──
  passport.authenticate('google', { 
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar.events'], 
    accessType: 'offline',
    prompt: 'consent', // Ensures you get the refresh token every time they reconnect
    session: false 
  })
);

router.get(
  '/google/callback',
  authRateLimiter,
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  controller.oauthCallback
);

// GitHub OAuth
router.get(
  '/github',
  authRateLimiter,
  passport.authenticate('github', { scope: ['user:email'], session: false })
);

router.get(
  '/github/callback',
  authRateLimiter,
  passport.authenticate('github', { session: false, failureRedirect: '/login' }),
  controller.oauthCallback
);

module.exports = router;