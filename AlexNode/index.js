// Load environment variables before anything else reads process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const prisma = require('./config/db');

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

  // Graceful shutdown: close the HTTP server and the Prisma connection
  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
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
