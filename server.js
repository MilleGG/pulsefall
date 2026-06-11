const express = require('express');
const path = require('path');

const app = express();

app.use(express.static(path.join(__dirname, 'public'), { etag: true }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 4311;
app.listen(port, () => {
  console.log(`PULSEFALL dropping beats on port ${port}`);
});
