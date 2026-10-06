const { app } = require('./app');
const { config, validateConfig } = require('./config');
const { pool } = require('./db');
const { migrate } = require('./migrate');

async function start() {
    validateConfig();
    await migrate();

    const server = app.listen(config.port, '0.0.0.0', () => {
        console.log(JSON.stringify({
            level: 'info',
            msg: 'server_started',
            port: config.port
        }));
    });

    function shutdown() {
        server.close(async () => {
            await pool.end();
            process.exit(0);
        });
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

start().catch(async (error) => {
    console.error(JSON.stringify({
        level: 'fatal',
        msg: 'startup_failed',
        error: error.message
    }));
    await pool.end();
    process.exit(1);
});