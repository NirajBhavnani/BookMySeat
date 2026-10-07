const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { pool } = require('./db');
const { ApiError } = require('./errors');

async function reserveSeats({ showId, userId, seats, idempotencyKey }) {
    const sortedSeats = [...seats].sort();
    const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(sortedSeats))
        .digest('hex');

    const client = await pool.connect();
    let transactionOpen = false;

    try {
        await client.query('BEGIN');
        transactionOpen = true;

        const showResult = await client.query(
            'SELECT id, price_paise, per_user_limit FROM shows WHERE id = $1',
            [showId]
        );

        if (!showResult.rowCount) {
            throw new ApiError(404, 'show_not_found');
        }

        const show = showResult.rows[0];

        await client.query(
            `INSERT INTO booking_guards (show_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [showId, userId]
        );

        await client.query(
            `SELECT 1 FROM booking_guards
       WHERE show_id = $1 AND user_id = $2 FOR UPDATE`,
            [showId, userId]
        );

        const previous = await client.query(
            `SELECT request_hash, reservation_id, decline_code
       FROM idempotency_records
       WHERE show_id = $1 AND user_id = $2 AND idempotency_key = $3`,
            [showId, userId, idempotencyKey]
        );

        if (previous.rowCount) {
            const record = previous.rows[0];

            if (record.request_hash !== requestHash) {
                throw new ApiError(409, 'idempotency_key_reused');
            }

            if (record.decline_code) {
                await client.query('COMMIT');
                transactionOpen = false;
                return {
                    replay: true,
                    decline: {
                        status: 409,
                        code: record.decline_code,
                        metricReason: declineMetricReason(record.decline_code)
                    }
                };
            }

            const reservation = await loadReservation(client, record.reservation_id);
            await client.query('COMMIT');
            transactionOpen = false;
            return { replay: true, reservation };
        }

        const lockedSeats = await client.query(
            `SELECT seat_no, status FROM seats
       WHERE show_id = $1 AND seat_no = ANY($2::text[])
       ORDER BY seat_no COLLATE "C" FOR UPDATE`,
            [showId, sortedSeats]
        );

        if (lockedSeats.rowCount !== sortedSeats.length) {
            const result = await saveDecline(client, {
                showId,
                userId,
                idempotencyKey,
                requestHash,
                code: 'unknown_seat'
            });
            transactionOpen = false;
            return result;
        }

        if (lockedSeats.rows.some((seat) => seat.status !== 'available')) {
            const result = await saveDecline(client, {
                showId,
                userId,
                idempotencyKey,
                requestHash,
                code: 'seat_taken'
            });
            transactionOpen = false;
            return result;
        }

        const activeSeats = await client.query(
            `SELECT COUNT(*)::int AS count
       FROM seats s
       JOIN reservations r ON r.id = s.reservation_id AND r.show_id = s.show_id
       WHERE s.show_id = $1 AND r.user_id = $2 AND r.status = 'confirmed'`,
            [showId, userId]
        );

        if (activeSeats.rows[0].count + sortedSeats.length > show.per_user_limit) {
            const result = await saveDecline(client, {
                showId,
                userId,
                idempotencyKey,
                requestHash,
                code: 'per_user_limit'
            });
            transactionOpen = false;
            return result;
        }

        const amount = BigInt(show.price_paise) * BigInt(sortedSeats.length);

        if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new ApiError(400, 'amount_too_large');
        }

        const reservationId = randomUUID();

        await client.query(
            `INSERT INTO reservations
                (id, show_id, user_id, status, amount_paise)
            VALUES ($1, $2, $3, 'confirmed', $4)`,
            [reservationId, showId, userId, amount.toString()]
        );

        await client.query(
            `INSERT INTO reservation_seats (reservation_id, show_id, seat_no)
       SELECT $1, $2, seat_no FROM unnest($3::text[]) AS seat_no`,
            [reservationId, showId, sortedSeats]
        );

        await client.query(
            `INSERT INTO idempotency_records
         (show_id, user_id, idempotency_key, request_hash, response_status, reservation_id)
       VALUES ($1, $2, $3, $4, 201, $5)`,
            [showId, userId, idempotencyKey, requestHash, reservationId]
        );

        const claimed = await client.query(
            `UPDATE seats
       SET status = 'confirmed', reservation_id = $3
       WHERE show_id = $1 AND seat_no = ANY($2::text[])
         AND status = 'available'`,
            [showId, sortedSeats, reservationId]
        );

        if (claimed.rowCount !== sortedSeats.length) {
            throw new Error('Seat claim count did not match request');
        }

        await client.query('COMMIT');
        transactionOpen = false;

        return {
            replay: false,
            reservation: {
                reservation_id: reservationId,
                show_id: showId,
                user_id: userId,
                seats: sortedSeats,
                amount_paise: Number(amount),
                status: 'confirmed'
            }
        };
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function cancelReservation({ reservationId, userId }) {
    const client = await pool.connect();
    let transactionOpen = false;

    try {
        await client.query('BEGIN');
        transactionOpen = true;

        const ownerResult = await client.query(
            'SELECT show_id, user_id FROM reservations WHERE id = $1',
            [reservationId]
        );

        if (!ownerResult.rowCount) {
            throw new ApiError(404, 'reservation_not_found');
        }

        const owner = ownerResult.rows[0];

        if (owner.user_id !== userId) {
            throw new ApiError(403, 'reservation_not_owned');
        }

        await client.query(
            `SELECT 1 FROM booking_guards
       WHERE show_id = $1 AND user_id = $2 FOR UPDATE`,
            [owner.show_id, userId]
        );

        const reservationResult = await client.query(
            `SELECT id, show_id, user_id, status, amount_paise
       FROM reservations WHERE id = $1 FOR UPDATE`,
            [reservationId]
        );

        const reservation = reservationResult.rows[0];
        const seatsResult = await client.query(
            `SELECT seat_no FROM reservation_seats
       WHERE reservation_id = $1
       ORDER BY seat_no COLLATE "C"`,
            [reservationId]
        );
        const seats = seatsResult.rows.map((row) => row.seat_no);

        if (reservation.status === 'confirmed') {
            await client.query(
                `SELECT seat_no FROM seats
         WHERE show_id = $1 AND seat_no = ANY($2::text[])
         ORDER BY seat_no COLLATE "C" FOR UPDATE`,
                [owner.show_id, seats]
            );

            await client.query(
                `UPDATE seats
         SET status = 'available', reservation_id = NULL
         WHERE show_id = $1 AND reservation_id = $2`,
                [owner.show_id, reservationId]
            );

            await client.query(
                `UPDATE reservations
         SET status = 'cancelled', cancelled_at = now()
         WHERE id = $1`,
                [reservationId]
            );
        }

        await client.query('COMMIT');
        transactionOpen = false;

        return {
            reservation_id: reservation.id,
            show_id: reservation.show_id,
            user_id: reservation.user_id,
            seats,
            amount_paise: Number(reservation.amount_paise),
            status: 'cancelled'
        };
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function loadReservation(client, reservationId) {
    const result = await client.query(
        `SELECT id, show_id, user_id, status, amount_paise
     FROM reservations WHERE id = $1`,
        [reservationId]
    );

    const seatsResult = await client.query(
        `SELECT seat_no FROM reservation_seats
     WHERE reservation_id = $1
     ORDER BY seat_no COLLATE "C"`,
        [reservationId]
    );

    const row = result.rows[0];

    return {
        reservation_id: row.id,
        show_id: row.show_id,
        user_id: row.user_id,
        seats: seatsResult.rows.map((seat) => seat.seat_no),
        amount_paise: Number(row.amount_paise),
        status: row.status
    };
}

async function saveDecline(client, {
    showId, userId, idempotencyKey, requestHash, code
}) {
    await client.query(
        `INSERT INTO idempotency_records
       (show_id, user_id, idempotency_key, request_hash, response_status, decline_code)
     VALUES ($1, $2, $3, $4, 409, $5)`,
        [showId, userId, idempotencyKey, requestHash, code]
    );

    await client.query('COMMIT');

    return {
        replay: false,
        decline: {
            status: 409,
            code,
            metricReason: declineMetricReason(code)
        }
    };
}

function declineMetricReason(code) {
    if (code === 'seat_taken') return 'seat-taken';
    if (code === 'per_user_limit') return 'per-user-limit';
    return 'unknown-seat';
}

module.exports = { cancelReservation, reserveSeats };