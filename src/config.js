const config = {
    port: Number(process.env.PORT || 3000),
    databaseUrl: process.env.DATABASE_URL,
    adminToken: process.env.ADMIN_TOKEN,
    jwtSecret: process.env.JWT_SECRET
};

function validateConfig() {
    if (!config.databaseUrl) {
        throw new Error('DATABASE_URL is required');
    }

    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error('PORT must be a valid TCP port');
    }

    if (!config.adminToken) {
        throw new Error('ADMIN_TOKEN is required');
    }

    if (!config.jwtSecret || config.jwtSecret.length < 32) {
        throw new Error('JWT_SECRET is required and must be at least 32 characters long');
    }
}

module.exports = { config, validateConfig };