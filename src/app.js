const express = require('express');
const pinoHttp = require('pino-http');
const { randomUUID } = require('node:crypto');
const { pool } = require('./db');
const { requireAdmin } = require('./auth');
const { createShow, getShow } = require('./reservation-service.js');

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

app.post('/shows', requireAdmin, async (req, res) => {
    const {
        name,
        seats,
        price_paise: pricePaise,
        per_user_limit: perUserLimit = 4
    } = req.body || {};

    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
        return res.status(400).json({ error: 'invalid_name' });
    }

    if (
        !Array.isArray(seats) ||
        seats.length === 0 ||
        seats.length > 10000 ||
        seats.some((seat) => typeof seat !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(seat)) ||
        new Set(seats).size !== seats.length
    ) {
        return res.status(400).json({ error: 'invalid_seats' });
    }

    if (!Number.isSafeInteger(pricePaise) || pricePaise < 0) {
        return res.status(400).json({ error: 'invalid_price_paise' });
    }

    if (!Number.isInteger(perUserLimit) || perUserLimit < 1) {
        return res.status(400).json({ error: 'invalid_per_user_limit' });
    }

    const show = await createShow({
        name: name.trim(),
        seats,
        pricePaise,
        perUserLimit
    });

    res.status(201).json(show);
});

app.get('/shows/:showId', async (req, res) => {
    const show = await getShow(req.params.showId);

    if (!show) {
        return res.status(404).json({ error: 'show_not_found' });
    }

    res.status(200).json(show);
});

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