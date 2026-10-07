const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { config } = require('./config');

function createDemoToken() {
  const userId = crypto.randomUUID();
  const token = jwt.sign({ sub: userId }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '30d'
  });

  return { userId, token };
}

function requireUser(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ error: 'authentication_required' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256']
    });

    if (typeof payload.sub !== 'string') {
      throw new Error('Token has no subject');
    }

    req.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);

  if (!token || !safeEqual(token, config.adminToken)) {
    return res.status(401).json({ error: 'admin_authentication_required' });
  }

  return next();
}

function getBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return match?.[1];
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { requireAdmin, createDemoToken, requireUser };