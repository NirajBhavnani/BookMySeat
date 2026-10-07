const express = require('express');
const pinoHttp = require('pino-http');
const { randomUUID } = require('node:crypto');
const { pool } = require('./db');
const { requireAdmin, createDemoToken, requireUser } = require('./auth');
const { createShow, getShow } = require('./show-service.js');
const { ApiError } = require('./errors');
const { cancelReservation, reserveSeats } = require('./reservation-service.js');
const { registry, reservationOutcomes, reservationsDeclined } = require('./metrics');

const app = express();
app.disable('x-powered-by');
app.use(pinoHttp({
    level: process.env.LOG_LEVEL || 'info',
    genReqId: (req, res) => {
        const requestId = req.get('x-request-id') || randomUUID();
        res.setHeader('X-Request-Id', requestId);
        return requestId;
    },
    customProps: (req) => ({ request_id: req.id }),
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

app.post('/auth/demo-token', (req, res) => {
    const identity = createDemoToken();
    res.status(201).json({
        user_id: identity.userId,
        access_token: identity.token,
        token_type: 'Bearer',
        expires_in: 2592000
    });
});

app.post('/shows', requireAdmin, async (req, res) => {
    const { name, seats, price_paise: pricePaise, per_user_limit: perUserLimit = config.perUserLimit } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
        throw new ApiError(400, 'invalid_name');
    }
    if (!Array.isArray(seats) || seats.length === 0 || seats.length > 10000 ||
        seats.some((seat) => typeof seat !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(seat)) ||
        new Set(seats).size !== seats.length) {
        throw new ApiError(400, 'invalid_seats');
    }
    if (!Number.isSafeInteger(pricePaise) || pricePaise < 0) {
        throw new ApiError(400, 'invalid_price_paise');
    }
    if (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 10000) {
        throw new ApiError(400, 'invalid_per_user_limit');
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
    if (!isUuid(req.params.showId)) throw new ApiError(404, 'show_not_found');
    res.status(200).json(await getShow(req.params.showId));
});

app.post('/shows/:showId/reserve', requireUser, async (req, res) => {
    if (!isUuid(req.params.showId)) throw new ApiError(404, 'show_not_found');
    const body = req.body || {};
    const headerKey = req.get('idempotency-key');
    if (headerKey && body.idempotency_key && headerKey !== body.idempotency_key) {
        throw new ApiError(400, 'idempotency_key_mismatch');
    }
    const idempotencyKey = headerKey || body.idempotency_key;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
        throw new ApiError(400, 'invalid_idempotency_key');
    }
    if (!Array.isArray(body.seats) || body.seats.length === 0 || body.seats.length > 10000 ||
        body.seats.some((seat) => typeof seat !== 'string') || new Set(body.seats).size !== body.seats.length) {
        throw new ApiError(400, 'invalid_seats');
    }

    const result = await reserveSeats({
        showId: req.params.showId,
        userId: req.userId,
        seats: body.seats,
        idempotencyKey
    });
    if (result.decline) {
        reservationsDeclined.inc({ reason: result.decline.metricReason });
        if (!result.replay) {
            reservationOutcomes.inc({ outcome: `declined-${result.decline.metricReason}` });
        }
        return res.status(result.decline.status).json({
            error: result.decline.code,
            request_id: req.id
        });
    }
    res.status(result.replay ? 200 : 201).json(result.reservation);
});

app.post('/reservations/:reservationId/cancel', requireUser, async (req, res) => {
    if (!isUuid(req.params.reservationId)) throw new ApiError(404, 'reservation_not_found');
    const result = await cancelReservation({
        reservationId: req.params.reservationId,
        userId: req.userId
    });
    res.status(200).json(result.reservation);
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

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.status(200).send(await registry.metrics());
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) {
        if (error.metricReason) {
            reservationsDeclined.inc({ reason: error.metricReason });
            reservationOutcomes.inc({ outcome: `declined-${error.metricReason}` });
        }
        return res.status(error.status).json({ error: error.code, request_id: req.id });
    }
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ error: 'invalid_json', request_id: req.id });
    }
    req.log.error({ err: error }, 'request failed');
    return res.status(500).json({ error: 'internal_error', request_id: req.id });
});

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

module.exports = { app };