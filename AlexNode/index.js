const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

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

app.listen(port, () => {
    console.log(`Server is successfully running on http://localhost:${port}`)
})
