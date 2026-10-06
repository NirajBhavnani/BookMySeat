const { randomUUID } = require('node:crypto');
const { pool } = require('./db');

async function createShow({ name, seats, pricePaise, perUserLimit }) {
    const client = await pool.connect();
    const showId = randomUUID();

    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO shows (id, name, price_paise, per_user_limit)
       VALUES ($1, $2, $3, $4)`,
            [showId, name, pricePaise, perUserLimit]
        );

        await client.query(
            `INSERT INTO seats (show_id, seat_no)
       SELECT $1, requested.seat_no
       FROM unnest($2::text[]) AS requested(seat_no)`,
            [showId, seats]
        );

        await client.query('COMMIT');

        return {
            id: showId,
            name,
            price_paise: pricePaise,
            per_user_limit: perUserLimit,
            total_seats: seats.length,
            seats: seats.map((seatNo) => ({
                seat_no: seatNo,
                status: 'available'
            }))
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getShow(showId) {
    const showResult = await pool.query(
        `SELECT id, name, price_paise, per_user_limit
     FROM shows
     WHERE id = $1`,
        [showId]
    );

    if (!showResult.rowCount) {
        return null;
    }

    const seatsResult = await pool.query(
        `SELECT seat_no, status
     FROM seats
     WHERE show_id = $1
     ORDER BY seat_no COLLATE "C"`,
        [showId]
    );

    const counts = {
        available: 0,
        held: 0,
        confirmed: 0,
        total_seats: seatsResult.rowCount
    };

    for (const seat of seatsResult.rows) {
        counts[seat.status] += 1;
    }

    const show = showResult.rows[0];

    return {
        id: show.id,
        name: show.name,
        price_paise: Number(show.price_paise),
        per_user_limit: show.per_user_limit,
        counts,
        seats: seatsResult.rows.map((seat) => ({
            seat_no: seat.seat_no,
            status: seat.status
        }))
    };
}

module.exports = { createShow, getShow };