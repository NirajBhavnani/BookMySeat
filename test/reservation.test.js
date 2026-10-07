const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

const { app } = require('../src/app');
const { config, validateConfig } = require('../src/config');
const { pool } = require('../src/db');
const { migrate } = require('../src/migrate');

let server;
let baseUrl;

before(async () => {
    validateConfig();
    await migrate();

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await pool.end();
});

test('a hot-seat race has exactly one winner and no 5xx responses', async () => {
    const show = await createShow(['A1']);
    const attempts = await Promise.all(
        Array.from({ length: 32 }, async (_, index) => {
            const user = await createUser();
            return reserve(show.id, user.token, ['A1'], `hot-seat-${index}`);
        })
    );

    assert.equal(attempts.filter((result) => result.status === 201).length, 1);
    assert.equal(attempts.filter((result) => result.status === 409).length, 31);
    assert.equal(attempts.filter((result) => result.status >= 500).length, 0);
});

test('parallel bookings cannot exceed the user limit', async () => {
    const show = await createShow(
        ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'],
        4
    );
    const user = await createUser();

    const attempts = await Promise.all(
        show.seats.map((seat) =>
            reserve(show.id, user.token, [seat.seat_no], `limit-${seat.seat_no}`)
        )
    );

    assert.equal(attempts.filter((result) => result.status === 201).length, 4);
    assert.equal(attempts.filter((result) => result.status === 409).length, 4);
    assert.equal(attempts.filter((result) => result.status >= 500).length, 0);
});

test('same idempotency key replays the original reservation', async () => {
    const show = await createShow(['C1', 'C2']);
    const user = await createUser();

    const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
            reserve(show.id, user.token, ['C1'], 'same-key')
        )
    );

    assert.equal(attempts.filter((result) => result.status === 201).length, 1);
    assert.equal(attempts.filter((result) => result.status === 200).length, 7);

    const reservationIds = new Set(
        attempts.map((result) => result.body.reservation_id)
    );
    assert.equal(reservationIds.size, 1);

    const changedSeats = await reserve(show.id, user.token, ['C2'], 'same-key');
    assert.equal(changedSeats.status, 409);
    assert.equal(changedSeats.body.error, 'idempotency_key_reused');
});

test('a multi-seat booking is all-or-nothing', async () => {
    const show = await createShow(['D1', 'D2', 'D3']);
    const firstUser = await createUser();
    const secondUser = await createUser();

    const claimed = await reserve(show.id, firstUser.token, ['D1'], 'claim-d1');
    assert.equal(claimed.status, 201);

    const partial = await reserve(
        show.id,
        secondUser.token,
        ['D1', 'D2'],
        'all-or-nothing'
    );
    assert.equal(partial.status, 409);

    const state = await getShow(show.id);
    assert.deepEqual(
        state.seats.map((seat) => seat.status),
        ['confirmed', 'available', 'available']
    );
});

test('only the reservation owner can cancel, then the seat can be rebooked', async () => {
    const show = await createShow(['E1']);
    const owner = await createUser();
    const otherUser = await createUser();

    const booking = await reserve(show.id, owner.token, ['E1'], 'book-e1');
    assert.equal(booking.status, 201);

    const forbidden = await fetch(
        `${baseUrl}/reservations/${booking.body.reservation_id}/cancel`,
        { method: 'POST', headers: authHeaders(otherUser.token) }
    );
    assert.equal(forbidden.status, 403);

    const cancelled = await fetch(
        `${baseUrl}/reservations/${booking.body.reservation_id}/cancel`,
        { method: 'POST', headers: authHeaders(owner.token) }
    );
    assert.equal(cancelled.status, 200);

    const rebooked = await reserve(show.id, otherUser.token, ['E1'], 'rebook-e1');
    assert.equal(rebooked.status, 201);
});

test('request body cannot spoof the authenticated user', async () => {
    const show = await createShow(['F1']);
    const user = await createUser();

    const response = await fetch(`${baseUrl}/shows/${show.id}/reserve`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
            seats: ['F1'],
            idempotency_key: 'spoof-test',
            user_id: 'someone-else'
        })
    });

    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.user_id, user.id);
});

async function createShow(seats, perUserLimit = 4) {
    const response = await fetch(`${baseUrl}/shows`, {
        method: 'POST',
        headers: authHeaders(config.adminToken),
        body: JSON.stringify({
            name: `test-${Date.now()}-${Math.random()}`,
            seats,
            price_paise: 25000,
            per_user_limit: perUserLimit
        })
    });

    assert.equal(response.status, 201);
    return response.json();
}

async function createUser() {
    const response = await fetch(`${baseUrl}/auth/demo-token`, {
        method: 'POST'
    });

    assert.equal(response.status, 201);
    const result = await response.json();

    return {
        id: result.user_id,
        token: result.access_token
    };
}

async function reserve(showId, token, seats, key) {
    const response = await fetch(`${baseUrl}/shows/${showId}/reserve`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
            seats,
            idempotency_key: key
        })
    });

    return {
        status: response.status,
        body: await response.json()
    };
}

async function getShow(showId) {
    const response = await fetch(`${baseUrl}/shows/${showId}`);
    assert.equal(response.status, 200);
    return response.json();
}

function authHeaders(token) {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    };
}