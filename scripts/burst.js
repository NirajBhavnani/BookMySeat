// Script to simulate burst traffic for the BookMySeat API
const baseUrl = (process.argv[2] || '').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN;
const userCount = Number(process.env.BURST_USERS || 500);
const retryCount = Number(process.env.BURST_RETRIES || 3);

if (!baseUrl || !adminToken) {
    console.error('Usage: ADMIN_TOKEN=... npm run burst -- <BASE_URL>');
    process.exit(2);
}

if (!Number.isInteger(userCount) || userCount < 2 || userCount > 20000) {
    console.error('BURST_USERS must be between 2 and 20000');
    process.exit(2);
}

if (!Number.isInteger(retryCount) || retryCount < 1 || retryCount > 100) {
    console.error('BURST_RETRIES must be between 1 and 100');
    process.exit(2);
}

main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
});

async function main() {
    const readyResponse = await fetch(`${baseUrl}/health/ready`);
    if (!readyResponse.ok) {
        throw new Error(`API is not ready: HTTP ${readyResponse.status}`);
    }

    const showResponse = await fetch(`${baseUrl}/shows`, {
        method: 'POST',
        headers: jsonHeaders(adminToken),
        body: JSON.stringify({
            name: `burst-${Date.now()}`,
            seats: ['A12', 'A13'],
            price_paise: 25000
        })
    });

    if (showResponse.status !== 201) {
        throw new Error(`Show creation failed: HTTP ${showResponse.status}`);
    }

    const show = await showResponse.json();

    const users = await mapWithConcurrency(
        Array.from({ length: userCount }, (_, index) => index),
        100,
        createUser
    );

    const attempts = users.map((user, index) => ({
        token: user.access_token,
        key: `burst-${show.id}-${index}`,
        seat: index === 0 ? 'A13' : 'A12'
    }));

    for (let retry = 1; retry < retryCount; retry += 1) {
        attempts.push({
            token: users[0].access_token,
            key: `burst-${show.id}-0`,
            seat: 'A13'
        });
    }

    const startedAt = Date.now();
    const results = await Promise.all(
        attempts.map((attempt) => reserve(show.id, attempt))
    );
    const outcomes = countOutcomes(results);

    const hotSeatResults = results.slice(1, userCount);
    const hotSeatWins = hotSeatResults.filter((result) => result.status === 201).length;
    const hotSeatDeclines = hotSeatResults.filter(
        (result) => result.status === 409 && result.body.error === 'seat_taken'
    ).length;

    const showState = await getJson(`${baseUrl}/shows/${show.id}`);
    const metricsResponse = await fetch(`${baseUrl}/metrics`);

    if (!metricsResponse.ok) {
        throw new Error(`Metrics request failed: HTTP ${metricsResponse.status}`);
    }

    const metricsText = await metricsResponse.text();
    const gaugeLine = metricsText.split('\n').find((line) =>
        line.startsWith(`seats_available{show_id="${show.id}"} `)
    );
    const metricAvailable = gaugeLine
        ? Number(gaugeLine.trim().split(/\s+/).at(-1))
        : null;

    const counts = showState.counts;
    const reconciliation = {
        available: counts.available,
        held: counts.held,
        confirmed: counts.confirmed,
        total_seats: counts.total_seats,
        counts_match_total:
            counts.available + counts.held + counts.confirmed === counts.total_seats,
        metric_available: metricAvailable,
        metric_matches_api: metricAvailable === counts.available
    };

    console.log(JSON.stringify({
        show_id: show.id,
        users: userCount,
        requests: attempts.length,
        duration_ms: Date.now() - startedAt,
        outcomes,
        hot_seat: {
            wins: hotSeatWins,
            seat_taken_declines: hotSeatDeclines
        },
        reconciliation,
        metric_counters: metricsText.split('\n').filter((line) =>
            line.startsWith('reservations_confirmed_total ') ||
            line.startsWith('reservations_declined_total{') ||
            line.startsWith('reservation_idempotent_replays_total ')
        )
    }, null, 2));

    const expectedHotSeatDeclines = userCount - 2;
    if (
        hotSeatWins !== 1 ||
        hotSeatDeclines !== expectedHotSeatDeclines ||
        outcomes['5xx'] > 0 ||
        outcomes.transport_errors > 0 ||
        outcomes.unexpected > 0 ||
        !reconciliation.counts_match_total ||
        !reconciliation.metric_matches_api
    ) {
        process.exitCode = 1;
    }
}

async function createUser() {
    const response = await fetch(`${baseUrl}/auth/demo-token`, {
        method: 'POST'
    });

    if (!response.ok) {
        throw new Error(`Demo-token request failed: HTTP ${response.status}`);
    }

    return response.json();
}

async function reserve(showId, attempt) {
    try {
        const response = await fetch(`${baseUrl}/shows/${showId}/reserve`, {
            method: 'POST',
            headers: {
                ...jsonHeaders(attempt.token),
                'idempotency-key': attempt.key
            },
            body: JSON.stringify({
                seats: [attempt.seat],
                idempotency_key: attempt.key
            })
        });

        return {
            status: response.status,
            body: await response.json()
        };
    } catch (error) {
        return {
            status: 0,
            body: { error: error.message }
        };
    }
}

function countOutcomes(results) {
    const counts = {
        confirmed: 0,
        'idempotent-replay': 0,
        'declined-seat-taken': 0,
        'declined-per-user-limit': 0,
        'declined-other': 0,
        '5xx': 0,
        transport_errors: 0,
        unexpected: 0
    };

    for (const result of results) {
        if (result.status === 201) {
            counts.confirmed += 1;
        } else if (result.status === 200) {
            counts['idempotent-replay'] += 1;
        } else if (result.status === 409 && result.body.error === 'seat_taken') {
            counts['declined-seat-taken'] += 1;
        } else if (result.status === 409 && result.body.error === 'per_user_limit') {
            counts['declined-per-user-limit'] += 1;
        } else if (result.status === 409) {
            counts['declined-other'] += 1;
        } else if (result.status >= 500) {
            counts['5xx'] += 1;
        } else if (result.status === 0) {
            counts.transport_errors += 1;
        } else {
            counts.unexpected += 1;
        }
    }

    return counts;
}

async function mapWithConcurrency(values, concurrency, callback) {
    const results = new Array(values.length);
    let nextIndex = 0;

    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, async () => {
            while (nextIndex < values.length) {
                const index = nextIndex;
                nextIndex += 1;
                results[index] = await callback(values[index]);
            }
        })
    );

    return results;
}

async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Request failed: HTTP ${response.status}`);
    }

    return response.json();
}

function jsonHeaders(token) {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    };
}