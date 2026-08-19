// cache.middleware.js

const redisClient = require('../config/redis.config');
const logger      = require('../config/logger.config');

// ─────────────────────────────────────────────
// cache(ttlSeconds, keyFn?)
//
// ttlSeconds — how long to cache the response
// keyFn      — optional fn(req) => string to build a custom cache key
//              defaults to the full URL (path + query string)
//
// Only caches 2xx JSON responses.
// Pass a custom keyFn when the cache should vary on auth user:
//   cache(60, (req) => `user:${req.user.id}:${req.originalUrl}`)
// ─────────────────────────────────────────────
function cache(ttlSeconds, keyFn) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') return next();

    const key = `cache:${keyFn ? keyFn(req) : req.originalUrl}`;

    try {
      const cached = await redisClient.get(key);
      if (cached) {
        res.setHeader('x-cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      // Cache read failure — degrade gracefully, don't block the request
      logger.warn({ err, key }, 'Cache read failed');
    }

    // Intercept res.json so we can store the response before sending
    const originalJson = res.json.bind(res);

    res.json = async (body) => {
      res.setHeader('x-cache', 'MISS');

      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          await redisClient.setEx(key, ttlSeconds, JSON.stringify(body));
        } catch (err) {
          logger.warn({ err, key }, 'Cache write failed');
        }
      }

      return originalJson(body);
    };

    next();
  };
}

// ─────────────────────────────────────────────
// invalidateCache(patterns)
//
// Call this in write operations (POST/PUT/DELETE)
// to bust related cache keys.
//
// Usage:
//   await invalidateCache(['cache:/api/products*']);
// ─────────────────────────────────────────────
async function invalidateCache(patterns = []) {
  for (const pattern of patterns) {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length) {
        await redisClient.del(keys);
        logger.info({ pattern, count: keys.length }, 'Cache invalidated');
      }
    } catch (err) {
      logger.warn({ err, pattern }, 'Cache invalidation failed');
    }
  }
}

module.exports = { cache, invalidateCache };

// ─────────────────────────────────────────────
// Usage in routes:
//
// const { cache, invalidateCache } = require('../middlewares/cache.middleware');
//
// // Cache product list for 5 minutes
// router.get('/products', cache(300), catchAsync(productController.list));
//
// // Cache per-user for 60 seconds
// router.get('/me', authenticate, cache(60, (req) => `user:${req.user.id}:/me`), catchAsync(userController.me));
//
// // Bust cache on write
// exports.createProduct = catchAsync(async (req, res) => {
//   const product = await ProductService.create(req.body);
//   await invalidateCache(['cache:/api/products*']);
//   res.status(201).json({ success: true, data: product });
// });
// ─────────────────────────────────────────────