const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3001;

console.log('[Startup] Pairing service starting...');
console.log('[Startup] PAIRING_SERVICE_API_KEY:', process.env.PAIRING_SERVICE_API_KEY ? 'SET' : 'MISSING');
console.log('[Startup] RAILWAY_TOKEN:', process.env.RAILWAY_TOKEN ? `SET` : 'MISSING');

const API_KEY = process.env.PAIRING_SERVICE_API_KEY;
if (!API_KEY) {
  console.error('FATAL: PAIRING_SERVICE_API_KEY not set');
  process.exit(1);
}

const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;
if (!RAILWAY_TOKEN) {
  console.error('FATAL: RAILWAY_TOKEN not set');
  process.exit(1);
}

app.use(express.json());

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get service name from Railway GraphQL
async function getServiceName(serviceId) {
  return new Promise((resolve, reject) => {
    const query = `
      query GetService($serviceId: String!) {
        service(id: $serviceId) {
          id
          name
        }
      }
    `;

    const data = JSON.stringify({ query, variables: { serviceId } });
    const options = {
      hostname: 'backboard.railway.app',
      path: '/graphql/v2',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RAILWAY_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.errors) {
            reject(new Error(JSON.stringify(result.errors)));
          } else if (!result.data?.service?.name) {
            reject(new Error('Service name not found'));
          } else {
            resolve(result.data.service.name);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Try multiple methods to approve pairing
async function approvePairing(serviceName, channel, code) {
  const methods = [
    // Method 1: OpenClaw Web API on port 18789 (if it has a pairing endpoint)
    { name: 'OpenClaw Gateway', port: 18789, path: '/api/pairing/approve' },
    // Method 2: Embedded pairing server on port 18800
    { name: 'Pairing Server', port: 18800, path: '/pairing/approve' },
  ];

  const errors = [];

  for (const method of methods) {
    try {
      console.log(`[Pairing] Trying ${method.name} at ${serviceName}.railway.internal:${method.port}${method.path}`);

      const result = await makeHttpRequest(serviceName, method.port, method.path, { channel, code });

      console.log(`[Pairing] ${method.name} responded:`, result.status, result.data);

      if (result.status >= 200 && result.status < 300 && result.data?.success !== false) {
        return { success: true, method: method.name, data: result.data };
      }

      errors.push(`${method.name}: HTTP ${result.status}`);
    } catch (err) {
      console.log(`[Pairing] ${method.name} failed:`, err.message);
      errors.push(`${method.name}: ${err.message}`);
    }
  }

  throw new Error(`All methods failed: ${errors.join('; ')}`);
}

// HTTP request helper
function makeHttpRequest(hostname, port, path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: `${hostname}.railway.internal`,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'openclaw-pairing-service' });
});

app.post('/pairing/approve', authenticate, async (req, res) => {
  const { serviceId, channel, code } = req.body;

  if (!serviceId || !channel || !code) {
    return res.status(400).json({ error: 'Missing required fields: serviceId, channel, code' });
  }

  if (!/^[A-Za-z0-9_-]{2,32}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }

  console.log(`[Pairing] Request: service=${serviceId}, channel=${channel}, code=${code}`);

  try {
    const serviceName = await getServiceName(serviceId);
    console.log(`[Pairing] Service name: ${serviceName}`);

    const result = await approvePairing(serviceName, channel, code);

    res.json({
      success: true,
      message: 'Pairing approved successfully',
      method: result.method,
      output: result.data?.output || result.data?.message
    });

  } catch (error) {
    console.error(`[Pairing] Failed:`, error.message);

    const command = `openclaw pairing approve ${channel} ${code}`;
    res.status(503).json({
      success: false,
      error: error.message,
      requiresManual: true,
      command,
      instructions: [
        '1. Go to Railway Dashboard',
        '2. Open your OpenClaw service → Deployments',
        '3. Click active deployment → Terminal',
        '4. Run: ' + command
      ]
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Pairing Service] Listening on 0.0.0.0:${PORT}`);
});
