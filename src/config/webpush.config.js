// config/webpush.config.js
const webpush = require('web-push');

const vapidEmail = process.env.VAPID_EMAIL || 'mailto:support@wealthflux.com';
const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;

// Strict Runtime Structural Assertions
if (!publicKey || !privateKey) {
  console.error('\n❌ [VAPID CONFIG ERROR] Web-Push Engine initialization rejected.');
  console.error(`-> VAPID_PUBLIC_KEY:  ${publicKey ? 'FOUND' : 'MISSING ❌'}`);
  console.error(`-> VAPID_PRIVATE_KEY: ${privateKey ? 'FOUND' : 'MISSING ❌'}\n`);
  throw new Error('VAPID credentials must be defined as valid strings inside your environment configuration array.');
}

// Instantiate internal signature coordinates configurations once globally
webpush.setVapidDetails(vapidEmail, publicKey, privateKey);

module.exports = webpush;