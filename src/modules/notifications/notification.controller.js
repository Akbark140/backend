// notification.controller.js (Synchronized & Hardened)

const notificationService = require('./notification.service');

// ─── GET /vapid-public-key ────────────────────────────────────────
const getVapidPublicKey = (req, res) => {
  try {
    const publicKey = notificationService.getVapidPublicKey();
    console.log('Serving VAPID Key:', publicKey); // <-- Add this debug log temporarily
    res.status(200).json({ publicKey });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve VAPID public key.' });
  }
};

// ─── POST /subscribe ──────────────────────────────────────────────
const subscribe = async (req, res) => {
  const { subscription } = req.body;
  // SECURE FIX: Extract userId from req.user rather than trusted client body parameters
  const userId = req.user?.id || req.body.user_id || null;

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object.' });
  }

  try {
    const saved = await notificationService.saveSubscription(subscription, userId);
    res.status(201).json({ message: 'Subscription saved successfully.', data: saved });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription.' });
  }
};

// ─── POST /unsubscribe ────────────────────────────────────────────
const unsubscribe = async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint is required.' });
  }

  try {
    const removed = await notificationService.removeSubscription(endpoint);
    if (!removed) {
      return res.status(404).json({ error: 'Subscription not found.' });
    }
    res.status(200).json({ message: 'Unsubscribed successfully.' });
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe.' });
  }
};

// ─── POST /send/:userId (Admin Only) ──────────────────────────────
const sendToUser = async (req, res) => {
  // NOTE: This remains req.params because an admin is targeting someone else's ID!
  const { userId } = req.params;
  const { title, body, url, type } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }

  try {
    const result = await notificationService.notifyUser(userId, { title, body, url, type });

    if (result.skipped) {
      return res.status(200).json({ message: 'User has opted out of this notification type.', result });
    }

    if (result.total === 0) {
      return res.status(404).json({ error: 'No subscriptions found for this user.' });
    }

    res.status(200).json({ message: 'Notification sent.', result });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ─── POST /broadcast (Admin Only) ─────────────────────────────────
const broadcast = async (req, res) => {
  const { title, body, url, type } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }

  try {
    const result = await notificationService.broadcastNotification({ title, body, url, type });
    res.status(200).json({ message: 'Broadcast sent.', result });
  } catch (err) {
    console.error('Broadcast error:', err.message);
    const status = err.message.includes('No subscribers') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
};

// ─── GET /history ─────────────────────────────────────────────────
const getHistory = async (req, res) => {
  // SECURE FIX: Extract context securely from the authenticated token payload
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const [history, total] = await Promise.all([
      notificationService.getNotificationHistory(userId, { limit, offset }),
      notificationService.getNotificationCount(userId),
    ]);

    res.status(200).json({
      data: history,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (err) {
    console.error('History error:', err.message);
    res.status(500).json({ error: 'Failed to fetch notification history.' });
  }
};

// ─── GET /preferences ─────────────────────────────────────────────
const getPreferences = async (req, res) => {
  // SECURE FIX: Extract directly from req.user context
  const userId = req.user.id;
  try {
    const prefs = await notificationService.getUserPreferences(userId);
    res.status(200).json({ data: prefs });
  } catch (err) {
    console.error('Get preferences error:', err.message);
    res.status(500).json({ error: 'Failed to fetch preferences.' });
  }
};

// ─── PATCH /preferences ───────────────────────────────────────────
const updatePreference = async (req, res) => {
  // SECURE FIX: Extract from context to block parameter manipulation
  const userId = req.user.id;
  const { type, enabled } = req.body;

  if (!type || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'type (string) and enabled (boolean) are required.' });
  }

  try {
    const pref = await notificationService.setUserPreference(userId, type, enabled);
    res.status(200).json({ message: 'Preference updated.', data: pref });
  } catch (err) {
    console.error('Update preference error:', err.message);
    res.status(500).json({ error: 'Failed to update preference.' });
  }
};

module.exports = {
  getVapidPublicKey,
  subscribe,
  unsubscribe,
  sendToUser,
  broadcast,
  getHistory,
  getPreferences,
  updatePreference,
};