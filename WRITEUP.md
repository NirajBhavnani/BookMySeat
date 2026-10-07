# Design Notes

## Atomic Reservation Decision

PostgreSQL is the system of record. Each reservation request runs in a transaction. A `(show_id, user_id)` row in `booking_guards` serializes one user's reservations and cancellations for that show. The service creates the guard with `INSERT ... ON CONFLICT DO NOTHING`, then locks it using `SELECT ... FOR UPDATE`. This makes the per-user active-seat count and idempotency decision serial for that user, including when two requests race to create the guard.

Requested seat rows are locked using `SELECT ... FOR UPDATE` ordered by `seat_no COLLATE "C"`. Every multi-seat request uses the same deterministic order. The service checks all requested rows and the per-user limit before changing any seat. Reservation history, current seat states, and the idempotency result are written in that same transaction. Any database error rolls the transaction back. The seat primary key `(show_id, seat_no)`, reservation foreign keys, and unique idempotency key provide database-level safeguards in addition to row locking.

Multi-seat requests are all-or-nothing. If a seat is occupied, unknown, or the request exceeds the user's limit, no requested seat is claimed. Domain conflicts return `409`, not a server error.

## Idempotency

`idempotency_records` has primary key `(show_id, user_id, idempotency_key)`, a SHA-256 hash of the canonical sorted seat list, and either a reservation reference or the original decline code/status. The row is written in the same transaction as a successful reservation. Declines are also recorded, so a retry cannot change its seat list after a failed first attempt. An identical retry replays the original success or decline; a different request bodyseat list using the key returns `409 idempotency_key_reused`.

The user ID comes from a verified HS256 bearer token. Demo tokens identify newly generated random UUIDs. The public demo-token endpoint is solely for evaluator convenience, not a production authentication system; show creation uses a separate admin bearer secret.

## Cancellation And Consistency

Cancellation requires the reservation owner. It locks the user's show guard, reservation, and seat rows in sorted order, then marks the reservation cancelled and makes its current seats available in one transaction. Historical seat associations and the reservation remain for auditability. Repeated cancellation returns the cancelled reservation; a released seat is bookable under a new idempotency key. This implementation chooses explicit cancellation, so `held` remains zero.

During a database partition or outage, the service fails closed: readiness returns 503 and reservation requests cannot confirm without PostgreSQL. Availability is sacrificed rather than risk duplicate ownership. Money uses integer paise; amounts exceeding JavaScript's safe-integer range are rejected.

## Operations

Structured logs include a correlation/request ID, method, URL, status, and response time; bearer headers are deliberately omitted. `/health/live` checks the process. `/health/ready` checks PostgreSQL. Prometheus metrics include confirmed reservations, declines by reason, idempotent replays, request outcomes, and per-show available seats. The burst script checks that the API count and per-show availability gauge agree.

Signals to investigate/page on: readiness failures or database connection exhaustion; any 5xx increase; a burst producing a second winner for one seat; invariant or metric/API reconciliation failures; unusual latency under hot-seat contention; and a sustained rise in seat-taken declines that may indicate an on-sale stampede or abuse.

## AI Use And Next Steps

AI assistance was used to plan the stack, scaffold the Express/PostgreSQL service, draft the transactional reservation implementation, create race-focused integration tests and the burst utility, and write the initial documentation. The implementation was iterated against a real local PostgreSQL container; the test suite and burst results were used to find and correct defects. I chose JavaScript/Express because it is familiar and adequate for the scope, PostgreSQL because its transactions and constraints directly express the correctness rules, and explicit cancellation plus all-or-nothing booking to keep the state model small. I will review and be prepared to explain every transaction, constraint, and test in the submission.

Next: deploy to an affordable persistent PostgreSQL host, run a larger staged burst on the public URL, add graceful database retry/backoff policy for transient failures, and consider an external identity provider before production use. No payment provider is integrated; the assignment's reservation endpoint records a reservation but does not charge a card.