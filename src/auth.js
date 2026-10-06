const crypto = require('node:crypto');
const { config } = require('./config');

function requireAdmin(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const provided = match?.[1];

  if (!provided || !safeEqual(provided, config.adminToken)) {
    return res.status(401).json({ error: 'admin_authentication_required' });
  }

  next();
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { requireAdmin };