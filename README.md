# Seat Reservation API

Small JSON API for assigned-seat reservations. PostgreSQL is the source of truth; reservations and cancellations are committed transactionally. Multi-seat requests are all-or-nothing. Money is stored and returned as integer paise.

## Run Locally

Requirements: Node.js 22.9 or newer, npm, and Docker Desktop with Compose.

1. Copy `.env.example` to `.env` and replace `JWT_SECRET` and `ADMIN_TOKEN` with local development values. PowerShell: `Copy-Item .env.example .env`.
2. Install dependencies: `npm ci`.
3. Start the API and PostgreSQL: `docker compose up --build --detach`.
4. Run the integration suite against the Compose database: `npm test`.
5. Run a 500-user hot-seat burst: `npm run burst -- http://localhost:3000`.

The API listens on `http://localhost:3000`. Compose uses development-only credentials; never reuse them in a public deployment. The test suite and burst utility create data in the configured database.

## API

Requests and responses use JSON, except /metrics, which returns Prometheus text. Responses include an `X-Request-Id`; provide your own value in that header to correlate a request with logs.

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/demo-token` | None | Issue a signed token for a new random test identity |
| `POST` | `/shows` | `Bearer <ADMIN_TOKEN>` | Create a show and its available seats |
| `GET` | `/shows/{id}` | None | Read seat states and reconciled counts |
| `POST` | `/shows/{id}/reserve` | User bearer token | Reserve one or more seats |
| `POST` | `/reservations/{id}/cancel` | Owner bearer token | Cancel a reservation and release its seats |
| `GET` | `/health/live` | None | Process liveness |
| `GET` | `/health/ready` | None | Readiness; returns 503 if PostgreSQL is unavailable |
| `GET` | `/metrics` | None | Prometheus text metrics |

Create a show with `name`, `seats`, `price_paise`, and optional `per_user_limit` (default 4):

```sh
curl -X POST http://localhost:3000/shows \
  -H 'Authorization: Bearer local-development-admin-token' \
  -H 'Content-Type: application/json' \
  -d '{"name":"friday-night","seats":["A12","A13"],"price_paise":25000}'
```

Get a test identity from `/auth/demo-token`, then reserve seats with its returned `access_token`:

```sh
curl -X POST http://localhost:3000/shows/SHOW_ID/reserve \
  -H 'Authorization: Bearer USER_ACCESS_TOKEN' \
  -H 'Idempotency-Key: order-123' \
  -H 'Content-Type: application/json' \
  -d '{"seats":["A12"]}'
```

Identity is derived only from the signed bearer token; any `user_id` in the request body is ignored. The demo-token endpoint is intentionally for evaluator testing, not production identity management. Show creation uses a separate admin secret.

Multi-seat reservation is all-or-nothing. A seat conflict, unknown seat, or per-user-limit violation returns `409`; malformed input returns `400`. A first successful reservation returns `201`; a successful idempotent replay returns the original reservation with `200`. Failed domain outcomes are also stored by idempotency key: an identical retry returns the same decline, while changing seats under that key returns `409 idempotency_key_reused`. Cancellation is owner-only and idempotent; a cancelled seat can be booked again with a new key.

`GET /shows/{id}` reports `available`, `held`, `confirmed`, and `total_seats`. This implementation uses explicit cancellation rather than temporary holds, so `held` is always zero. The three counts reconcile to the total.

## Tests And Burst

The PostgreSQL-backed tests cover parallel hot-seat contention, parallel user-limit enforcement, successful idempotent replay and rejection of key reuse with changed seats, all-or-nothing requests, cancellation/rebooking, and identity spoofing. The burst script checks that API seat counts reconcile and match the `seats_available` metric. Start Compose before running `npm test`.

The burst script creates a show, mints distinct demo identities, races all but one identity for `A12`, and makes one identity retry the same successful `A13` reservation key. It prints outcome counts, 5xx/transport errors, API seat counts, and the matching `seats_available{show_id="..."}` metric.

```sh
BURST_USERS=2000 BURST_RETRIES=3 ADMIN_TOKEN=your-admin-token \
  npm run burst -- https://your-public-api.example
```

`BURST_USERS` supports 2 to 20,000 identities (default 500); `BURST_RETRIES` supports 1 to 100 total requests with the same successful key (default 3). The script exits non-zero on 5xx responses, transport failures, or a failed reconciliation. For PowerShell, set environment variables with `$env:BURST_USERS = "2000"` before the npm command.

## Metrics And Logs

- `reservations_confirmed_total`: new confirmed reservations.
- `reservations_declined_total{reason="seat-taken|per-user-limit|unknown-seat"}`: declined reservation responses.
- `reservation_idempotent_replays_total`: successful or declined requests replayed from stored idempotency outcomes.
- `reservation_requests_total{outcome="confirmed|idempotent-replay|declined-*"}`: request outcomes.
- `seats_available{show_id="..."}`: current available-seat gauge for each show, including zero for a sold-out show.

Logs are newline-delimited structured JSON with request ID, method, URL, response status, and latency. Authorization headers are excluded. Locally inspect them with `docker compose logs -f api`; on deployment, use the host's log viewer or export its logs.

## Deployment

Build and run the included Dockerfile on a container host with a persistent PostgreSQL service. Configure `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), `ADMIN_TOKEN`, `PORT` (the platform-provided port), and optionally `PER_USER_LIMIT`. The process applies pending SQL migrations under a PostgreSQL advisory lock before listening. Configure the platform health check as `/health/ready`; it fails closed when PostgreSQL cannot be reached. Expose `/metrics` to your Prometheus-compatible collector.

The repository does not contain cloud credentials or a public URL. After deployment, provide the URL and the admin credential to evaluators through the submission channel; do not commit either secret. Check provider pricing, database persistence, and cold-start limits before selecting a plan.