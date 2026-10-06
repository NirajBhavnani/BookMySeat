const express = require('express');
const pinoHttp = require('pino-http');
const { randomUUID } = require('node:crypto');

const app = express();

app.disable('x-powered-by');

app.use(pinoHttp({
  genReqId: (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    return requestId;
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      remoteAddress: req.remoteAddress
    })
  }
}));

app.use(express.json({ limit: '256kb' }));

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

module.exports = { app };