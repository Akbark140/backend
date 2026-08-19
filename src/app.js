// app.js
const Sentry = require('./config/sentry.config');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const { config } = require('../src/config/index.config');

// Middlewares
const requestLogger = require('./middleware/requestLogger.middleware');
const notFound = require('./middleware/notFound.middleware');
const { errorHandler } = require('./middleware/errorHandler.middleware');
const { apiLimiter } = require('./middleware/rateLimiter.middleware');

// Routes
const authRoutes = require('./modules/auth/auth.routes');
const budgetsRouter = require('./modules/budgets/budget.routes');
const transactionsRouter = require('./modules/transactions/transactions.routes');
const usersRouter = require('./modules/users/users.routes');
const { categoriesRouter } = require('./modules/categories/categories.routes');
const { reportsRouter } = require('./modules/reports/reports.routes');
const notificationRouter = require('./modules/notifications/notification.routes');
const searchRouter = require('./modules/search/search.routes');
const aiRoutes = require('./modules/ai/ai.routes');
const billsRouter = require('./modules/bills/bills.routes');
const goalsRoutes = require('./modules/goals/goals.routes');
const recurringRoutes = require('./modules/recurring/recurring.routes');
const accountsRouter = require('./modules/accounts/accounts.routes');
const contactRoutes = require('./modules/contact/contact.routes');
const featureRoutes = require('./modules/features/feature.routes');
const importRouter = require('./modules/import/import.routes');
const paymentRouter = require('./modules/payments/payments.routes');
const assetRouter = require('./modules/assets/asset.routes');
const TaxRoutes = require('./modules/tax_calculation/tax.routes');

const app = express();

// ─────────────────────────────────────────────
// Security & Basic Config
// ─────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", "https://locations-breathing-acres-mats.trycloudflare.com ", config.FRONTEND_URL],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
}));

app.use(cors({
  origin:"https://wealth-flux.vercel.app",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

app.use(compression());
app.use(cookieParser()); // Must be before routes

// ─────────────────────────────────────────────
// Body Parsers & Logging
// ─────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (config.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(requestLogger);
app.use(apiLimiter);

// ─────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is running' });
});

app.use('/api/auth', authRoutes);
app.use('/api/budgets', budgetsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/users', usersRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/search', searchRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/ai', aiRoutes);
app.use('/api/bills', billsRouter);
app.use('/api/goals', goalsRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/accounts', accountsRouter);
app.use('/api/features', featureRoutes);
app.use('/api/transactions/import', importRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/assets', assetRouter);
app.use('/api/tax', TaxRoutes);

app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'Budget Management System API' });
});

// ─────────────────────────────────────────────
// Error Handling (Must be last)
// ─────────────────────────────────────────────

app.use(notFound);

// Sentry error capturing
app.use((err, req, res, next) => {
  Sentry.captureException(err);
  next(err);
});

// Final Error Handler
app.use(errorHandler);

module.exports = app;