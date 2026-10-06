const { app } = require('./app');

const port = Number(process.env.PORT || 3000);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: 'server_started',
    port
  }));
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);