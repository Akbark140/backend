/**
 * Authentication Controller
 * * Part of the API/Routing layer. Responsible for handling incoming HTTP requests,
 * extracting payloads, invoking the core authentication service logic, and 
 * returning standardized HTTP responses.
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const authService = require('./auth.service');
const { sendSuccess } = require('../../shared/ApiResponse');
const { config } = require('../../config/index.config');

/**
 * Helper: Set secure authentication cookies (HttpOnly)
 */
function setAuthCookies(res, tokens) {
  const isProduction = process.env.NODE_ENV === 'production';
  
  //  Access Token Cookie (15 minutes)
  res.cookie('accessToken', tokens.accessToken, {
    httpOnly: true,                    // JS cannot access
    secure: isProduction,              // HTTPS only in production
    sameSite: 'lax',                   // Cross-origin friendly but CSRF protected
    maxAge: 15 * 60 * 1000,            // 15 minutes
    path: '/',
  });

  // Refresh Token Cookie (7 days)
  res.cookie('refreshToken', tokens.refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 days
    path: '/',
  });
}

/**
 * Get current authenticated user profile
 * Route: GET /auth/me
 * Access: Private (Requires Auth Middleware)
 */
async function me(req, res, next) {
  try {
    // Extract user ID favoring standard 'id' fallback to JWT 'sub' (subject) claim
    const user = await authService.getMe(req.user.id ?? req.user.sub);
    
    // Fail early if the user record no longer exists in the database
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({ success: true, data: user });
  } catch (err) {
    next(err); // Pass unexpected errors to the global error-handling middleware
  }
}

/**
 * Register a new user account
 * Route: POST /auth/register
 * Access: Public
 */
async function register(req, res, next) {
  try {
    // Pass user details payload to service layer to handle validation, hashing, and storage
    const tokens = await authService.register(req.body);
    
    //  Set secure HttpOnly cookies
    setAuthCookies(res, tokens);
    
    // Decode JWT to get user info (or call getMe with decoded user ID)
    const decoded = jwt.decode(tokens.accessToken);
    const user = await authService.getMe(decoded.sub);
    
    //  Return only user data (tokens are in HttpOnly cookies)
    sendSuccess(res, { user }, 201);
  } catch (err) {
    next(err);
  }
}

/**
 * Authenticate user credentials (Traditional Login)
 * Route: POST /auth/login
 * Access: Public
 */
async function login(req, res, next) {
  try {
    const tokens = await authService.login(req.body);
    
    // Set secure HttpOnly cookies
    setAuthCookies(res, tokens);
    
    // Decode JWT to get user info
    const decoded = jwt.decode(tokens.accessToken);
    const user = await authService.getMe(decoded.sub);
    
    // Return only user data (tokens are in HttpOnly cookies)
    sendSuccess(res, { user });
  } catch (err) {
    next(err);
  }
}

/**
 * Renew expired access token using a valid refresh token
 * Route: POST /auth/refresh
 * Access: Public (Rotational)
 */
async function refresh(req, res, next) {
  try {
    // Extract refreshToken from cookies
    const { refreshToken } = req.cookies;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token not found',
      });
    }

    const tokens = await authService.refresh(refreshToken);
    
    //  Clear old cookies and set new ones
    setAuthCookies(res, tokens);
    
    //  Decode JWT to get user info
    const decoded = require('jsonwebtoken').decode(tokens.accessToken);
    const user = await authService.getMe(decoded.sub);
    
    // Return only user data
    sendSuccess(res, { user });
  } catch (err) {
    next(err);
  }
}

/**
 * Invalidate user tokens and terminate session
 * Route: POST /auth/logout
 * Access: Private
 */
async function logout(req, res, next) {
  try {
    // Extract tokens from cookies
    const { accessToken, refreshToken } = req.cookies;

    // Invalidate tokens if needed (e.g., add to blacklist)
    if (accessToken || refreshToken) {
      await authService.logout(accessToken, refreshToken);
    }

    // Clear cookies
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
    };
    res.clearCookie('accessToken', cookieOptions);
    res.clearCookie('refreshToken', cookieOptions);

    sendSuccess(res, { message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

/**
 * Process successful Passport OAuth authentication redirects
 * Route: GET /auth/[provider]/callback
 * Access: Third-Party Public Redirect
 */
async function oauthCallback(req, res) {
  // Passport-derived token payload injected post-strategy execution
  const tokens = req.user || {};
  const { FRONTEND_URL } = config;

  // Validate tokens exist
  if (!tokens.accessToken) {
    return res.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
  }

  // Set secure HttpOnly cookies (NOT in URL)
  res.cookie('accessToken', tokens.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000,
    path: '/',
  });

  res.cookie('refreshToken', tokens.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  //  Redirect WITHOUT tokens in URL
  res.redirect(`${FRONTEND_URL}/dashboard`);
}

async function verifyEmail(req, res, next) {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token is required.' });

    await service.verifyEmail(token);
    sendSuccess(res, { message: 'Email verified successfully.' });
  } catch (err) {
    next(err);
  }
}

async function resendVerification(req, res, next) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    await authService.resendVerification(email);

    sendSuccess(res, { message: 'Verification email sent successfully.' });
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    await authService.forgotPassword(email);
    sendSuccess(res, { message: 'Reset code sent to your email.' });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { code, newPassword } = req.body;
    if (!code || !newPassword) {
      return res.status(400).json({ message: 'Code and new password are required.' });
    }

    await authService.resetPassword(code, newPassword);
    sendSuccess(res, { message: 'Password reset successfully.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  me,
  register,
  login,
  refresh,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword, 
  logout,
  oauthCallback,
};