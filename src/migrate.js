const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('./db');

async function migrate() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [78120419]);
        await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

        const directory = path.join(__dirname, '..', 'migrations');
        const files = (await fs.readdir(directory))
            .filter((name) => name.endsWith('.sql'))
            .sort();

        for (const filename of files) {
            const existing = await client.query(
                'SELECT 1 FROM schema_migrations WHERE filename = $1',
                [filename]
            );

            if (existing.rowCount) continue;

            const sql = await fs.readFile(path.join(directory, filename), 'utf8');
            await client.query(sql);
            await client.query(
                'INSERT INTO schema_migrations(filename) VALUES ($1)',
                [filename]
            );
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    migrate()
        .then(() => pool.end())
        .catch(async (error) => {
            console.error(error);
            await pool.end();
            process.exitCode = 1;
        });
}

module.exports = { migrate };