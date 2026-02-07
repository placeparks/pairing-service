const express = require('express');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

console.log('[Startup] Pairing service starting...');

const API_KEY = process.env.PAIRING_SERVICE_API_KEY;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;

if (!API_KEY) {
  console.error('FATAL: PAIRING_SERVICE_API_KEY not set');
  process.exit(1);
}

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
          if (result.errors || !result.data?.service?.name) {
            reject(new Error('Service not found'));
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

// Approve pairing via OpenClaw WebSocket gateway protocol
async function approvePairingViaGateway(serviceName, gatewayToken, channel, code) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://${serviceName}.railway.internal:18789`;
    console.log(`[Pairing] Connecting to OpenClaw gateway at ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    let timeout;
    let messageId = 1;

    ws.on('open', () => {
      console.log(`[Pairing] WebSocket connected, waiting for challenge...`);

      // Set overall timeout
      timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Gateway timeout - no response in 20 seconds'));
      }, 20000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`[Pairing] Gateway message:`, JSON.stringify(msg));

        // Handle challenge (initial frame from gateway)
        if (msg.type === 'challenge') {
          console.log(`[Pairing] Received challenge, sending connect...`);

          // Send connect request with auth token
          const connectMsg = {
            type: 'req',
            id: messageId++,
            method: 'connect',
            params: {
              protocol: 'openclaw-gateway/v1',
              client: {
                name: 'pairing-service',
                version: '1.0.0'
              },
              role: 'admin', // Try admin role for pairing operations
              scopes: ['pairing']
            }
          };

          // Add auth token if provided
          if (gatewayToken) {
            connectMsg.params.auth = { token: gatewayToken };
          }

          ws.send(JSON.stringify(connectMsg));
        }

        // Handle connect response (hello-ok)
        else if (msg.type === 'res' && msg.ok && msg.payload?.protocol) {
          console.log(`[Pairing] Connected to gateway, sending pair.approve...`);

          // Send node.pair.approve request
          const approveMsg = {
            type: 'req',
            id: messageId++,
            method: 'node.pair.approve',
            params: {
              channel,
              code
            }
          };

          ws.send(JSON.stringify(approveMsg));
        }

        // Handle pair.approve response
        else if (msg.type === 'res' && msg.id >= 2) {
          clearTimeout(timeout);

          if (msg.ok) {
            console.log(`[Pairing] Pairing approved successfully`);
            ws.close();
            resolve(msg.payload || { success: true });
          } else {
            console.log(`[Pairing] Pairing failed:`, msg.error);
            ws.close();
            reject(new Error(msg.error?.message || 'Pairing rejected by gateway'));
          }
        }

        // Handle error responses
        else if (msg.type === 'res' && !msg.ok) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.error?.message || 'Gateway error'));
        }

      } catch (err) {
        console.error(`[Pairing] Failed to parse message:`, err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[Pairing] WebSocket error:`, err.message);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`[Pairing] WebSocket closed: ${code} ${reason || ''}`);
    });
  });
}

// Fallback: approve pairing via HTTP pairing server on port 18800
async function approvePairingViaHttp(serviceName, channel, code) {
  return new Promise((resolve, reject) => {
    const url = `http://${serviceName}.railway.internal:18800/pairing/approve`;
    console.log(`[Pairing] HTTP fallback: POST ${url}`);

    const payload = JSON.stringify({ channel, code });
    const options = {
      hostname: `${serviceName}.railway.internal`,
      port: 18800,
      path: '/pairing/approve',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 15000
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          console.log(`[Pairing] HTTP fallback response:`, result);
          if (res.statusCode === 200 && result.success) {
            resolve(result);
          } else {
            reject(new Error(result.message || 'HTTP pairing failed'));
          }
        } catch (err) {
          reject(new Error('Invalid response from pairing server'));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP pairing server timeout'));
    });

    req.on('error', (err) => {
      reject(new Error(`HTTP pairing server error: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// Helper: wait ms
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'openclaw-pairing-service' });
});

app.post('/pairing/approve', authenticate, async (req, res) => {
  const { serviceId, channel, code, gatewayToken } = req.body;

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

    // Attempt 1: WebSocket gateway (port 18789)
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Pairing] WebSocket attempt ${attempt}/2...`);
        const result = await approvePairingViaGateway(serviceName, gatewayToken, channel, code);
        return res.json({
          success: true,
          message: 'Pairing approved successfully',
          result
        });
      } catch (err) {
        lastError = err;
        console.warn(`[Pairing] WebSocket attempt ${attempt} failed:`, err.message);
        if (attempt < 2) await sleep(3000);
      }
    }

    // Attempt 2: HTTP pairing server fallback (port 18800)
    try {
      console.log(`[Pairing] Trying HTTP fallback (port 18800)...`);
      const result = await approvePairingViaHttp(serviceName, channel, code);
      return res.json({
        success: true,
        message: 'Pairing approved via HTTP fallback',
        result
      });
    } catch (httpErr) {
      console.warn(`[Pairing] HTTP fallback also failed:`, httpErr.message);
    }

    // Both methods failed — return manual instructions
    console.error(`[Pairing] All methods failed. Last WS error:`, lastError?.message);

    const command = `openclaw pairing approve ${channel} ${code}`;
    res.status(503).json({
      success: false,
      error: lastError?.message || 'Connection failed',
      requiresManual: true,
      command,
      instructions: [
        '1. Go to Railway Dashboard',
        '2. Open your OpenClaw service → Deployments',
        '3. Click active deployment → Terminal',
        '4. Run: ' + command
      ]
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
  console.log(`[Pairing Service] Using OpenClaw WebSocket gateway protocol`);
});
