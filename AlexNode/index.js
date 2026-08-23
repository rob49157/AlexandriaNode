// Load environment variables before anything else reads process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const prisma = require('./config/db');
const uploadRoutes = require('./routes/upload.routes');
const searchRoutes = require('./routes/search.routes');
const rentalRoutes = require('./routes/rental.routes');
const stakeRoutes = require('./routes/stake.routes');
const chainRoutes = require('./routes/chain.routes');
const eventListener = require('./services/eventListener.service');
const { notFound, errorHandler } = require('./middleware/error.middleware');

const app = express();
const port = process.env.PORT || 3001;

// Security headers
app.use(helmet());
// Allow the Vite frontend (localhost:5173) to call this API from the browser
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

// Basic health check the frontend can hit to confirm the connection
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'alexandria-backend', time: new Date().toISOString() });
});

// API routes
app.use('/api', uploadRoutes);
app.use('/api', searchRoutes);
app.use('/api', rentalRoutes);
app.use('/api', stakeRoutes);
app.use('/api', chainRoutes);

// 404 + global error handler — must be registered last, after all routes.
app.use(notFound);
app.use(errorHandler);

// Connect to Postgres, then start the HTTP server
async function start() {
  try {
    await prisma.$connect();
    console.log('Connected to Postgres via Prisma');
  } catch (err) {
    console.error('Failed to connect to the database:', err);
    process.exit(1);
  }

  const server = app.listen(port, () => {
    console.log(`Server is successfully running on http://localhost:${port}`);
  });

  // On-chain event listener. Started after the server is up and never awaited:
  // a cold backfill walks millions of blocks, and the API must serve traffic
  // throughout. Set EVENT_LISTENER_ENABLED=false to run the API without it
  // (offline development, or when the RPC quota matters more than fresh status).
  const listenerEnabled = process.env.EVENT_LISTENER_ENABLED !== 'false';
  if (listenerEnabled) {
    try {
      eventListener.start();
    } catch (err) {
      // A misconfigured listener must not stop the API from serving reads.
      console.error('[events] listener failed to start:', err.message);
    }
  } else {
    console.log('[events] listener disabled (EVENT_LISTENER_ENABLED=false)');
  }

  // Graceful shutdown: stop the listener, close the HTTP server and Prisma
  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    eventListener.stop();
    server.close(async () => {
      await prisma.$disconnect();
      console.log('HTTP server closed and database disconnected');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
