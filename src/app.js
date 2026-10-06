const express = require('express');
const pinoHttp = require('pino-http');
const { randomUUID } = require('node:crypto');
const { pool } = require('./db');

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

app.get('/health/ready', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ status: 'ready' });
    } catch (error) {
        req.log.error({ err: error }, 'readiness check failed');
        res.status(503).json({ status: 'not_ready' });
    }
});

module.exports = { app };