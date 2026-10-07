const config = {
    port: Number(process.env.PORT || 3000),
    databaseUrl: process.env.DATABASE_URL,
    adminToken: process.env.ADMIN_TOKEN,
    jwtSecret: process.env.JWT_SECRET,
    perUserLimit: Number(process.env.PER_USER_LIMIT || 4)
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

    if (!Number.isInteger(config.perUserLimit) || config.perUserLimit < 1) {
        throw new Error('PER_USER_LIMIT must be a positive integer');
    }
}

module.exports = { config, validateConfig };