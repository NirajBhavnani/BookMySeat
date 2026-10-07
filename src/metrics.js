const client = require('prom-client');
const { pool } = require('./db');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const reservationsConfirmed = new client.Counter({
    name: 'reservations_confirmed_total',
    help: 'Number of newly confirmed reservations.',
    registers: [registry]
});

const reservationsDeclined = new client.Counter({
    name: 'reservations_declined_total',
    help: 'Reservation declines by domain reason.',
    labelNames: ['reason'],
    registers: [registry]
});

const reservationOutcomes = new client.Counter({
    name: 'reservation_requests_total',
    help: 'Reservation request outcomes, including successful idempotent replays.',
    labelNames: ['outcome'],
    registers: [registry]
});

const idempotentReplays = new client.Counter({
    name: 'reservation_idempotent_replays_total',
    help: 'Successful requests replayed from an existing idempotency record.',
    registers: [registry]
});

const availableSeats = new client.Gauge({
    name: 'seats_available',
    help: 'Current number of available seats per show.',
    labelNames: ['show_id'],
    registers: [registry],
    async collect() {
        const result = await pool.query(
            `SELECT shows.id AS show_id,
              COUNT(seats.seat_no) FILTER (WHERE seats.status = 'available')::bigint AS count
       FROM shows
       LEFT JOIN seats ON seats.show_id = shows.id
       GROUP BY shows.id`
        );
        this.reset();
        for (const row of result.rows) {
            this.set({ show_id: row.show_id }, Number(row.count));
        }
    }
});

module.exports = {
    availableSeats,
    idempotentReplays,
    registry,
    reservationOutcomes,
    reservationsConfirmed,
    reservationsDeclined
};