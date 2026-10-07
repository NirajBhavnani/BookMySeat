class ApiError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

module.exports = { ApiError };