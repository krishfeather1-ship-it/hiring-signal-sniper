const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// HubSpot API proxy — browser can't call HubSpot directly (CORS)
app.all('/api/hubspot/*', async (req, res) => {
  const hubspotPath = req.params[0];
  const token = req.headers['x-hubspot-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-hubspot-token header' });
  try {
    const url = `https://api.hubapi.com/${hubspotPath}`;
    const opts = {
      method: req.method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body);
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
app.listen(PORT, () => console.log(`Hiring Signal Sniper running on port ${PORT}`));
