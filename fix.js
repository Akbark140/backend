const fs = require('fs');
const p = 'e:/WealthFlux/backend/tests/unit/transactions.service.test.js';
let c = fs.readFileSync(p, 'utf8');
c = c.replace(/'user-123'/g, "'00000000-0000-0000-0000-000000000123'");
c = c.replace(/'txn-123'/g, "'00000000-0000-0000-0000-000000000456'");
c = c.replace(/'invalid-txn-id'/g, "'00000000-0000-0000-0000-000000000999'");
fs.writeFileSync(p, c);
console.log('done');
