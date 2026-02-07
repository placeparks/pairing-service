const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

console.log('[Startup] Checking environment variables...');
console.log('[Startup] PAIRING_SERVICE_API_KEY:', process.env.PAIRING_SERVICE_API_KEY ? 'SET' : 'MISSING');
console.log('[Startup] RAILWAY_TOKEN:', process.env.RAILWAY_TOKEN ? `SET (${process.env.RAILWAY_TOKEN.substring(0, 8)}...)` : 'MISSING');
console.log('[Startup] RAILWAY_PROJECT_ID:', process.env.RAILWAY_PROJECT_ID || 'MISSING');
console.log('[Startup] RAILWAY_ENVIRONMENT_ID:', process.env.RAILWAY_ENVIRONMENT_ID || 'MISSING');

// Security: Require API key for all requests
const API_KEY = process.env.PAIRING_SERVICE_API_KEY;
if (!API_KEY) {
  console.error('FATAL: PAIRING_SERVICE_API_KEY environment variable not set');
  console.error('Set this in Railway: Settings → Variables');
  process.exit(1);
}

// Railway credentials
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;
// Use TARGET_* for the project where OpenClaw instances live
// (not the pairing service's own project)
const PROJECT_ID = process.env.TARGET_RAILWAY_PROJECT_ID || process.env.RAILWAY_PROJECT_ID;
const ENV_ID = process.env.TARGET_RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT_ID;

if (!RAILWAY_TOKEN) {
  console.error('FATAL: RAILWAY_TOKEN not set');
  console.error('Set this in Railway: Settings → Variables');
  process.exit(1);
}

if (!PROJECT_ID || !ENV_ID) {
  console.error('WARNING: RAILWAY_PROJECT_ID or RAILWAY_ENVIRONMENT_ID not set automatically');
  console.error('These should be auto-set by Railway. Manual workaround:');
  console.error('1. Get values from your main app environment');
  console.error('2. Set them manually in pairing-service Variables');
  console.error('PROJECT_ID:', PROJECT_ID || 'NOT SET');
  console.error('ENV_ID:', ENV_ID || 'NOT SET');
  console.error('');
  console.error('The service will start but Railway CLI commands may fail without these.');
  console.error('Continuing anyway...');
}

app.use(express.json());

// Auth middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'openclaw-pairing-service' });
});

// Approve pairing
app.post('/pairing/approve', authenticate, async (req, res) => {
  const { serviceId, channel, code } = req.body;

  // Validate inputs
  if (!serviceId || typeof serviceId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid serviceId' });
  }

  if (!channel || typeof channel !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid channel' });
  }

  if (!code || typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(code)) {
    return res.status(400).json({ error: 'Missing or invalid code' });
  }

  console.log(`[Pairing] Approving ${channel} pairing for service ${serviceId} with code ${code}`);

  try {
    // Use Railway CLI to execute the command in the target service
    const command = `openclaw pairing approve ${channel} ${code}`;
    const railwayCmd = `railway run --project ${PROJECT_ID} --environment ${ENV_ID} --service ${serviceId} -- ${command}`;

    console.log(`[Pairing] Executing: ${railwayCmd}`);

    const { stdout, stderr } = await execAsync(railwayCmd, {
      timeout: 20000,
      env: {
        ...process.env,
        RAILWAY_TOKEN
      }
    });

    console.log(`[Pairing] stdout:`, stdout);
    if (stderr) console.log(`[Pairing] stderr:`, stderr);

    // Check if command succeeded
    const success = stdout.toLowerCase().includes('approved') ||
                   (!stderr.toLowerCase().includes('error') && !stderr.toLowerCase().includes('failed'));

    res.json({
      success,
      message: success ? 'Pairing approved successfully' : 'Command executed (check output)',
      output: stdout || stderr,
      command
    });

  } catch (error) {
    console.error(`[Pairing] Error:`, error.message);

    // Check if Railway CLI is not available
    if (error.message.includes('railway: not found') || error.message.includes('command not found')) {
      return res.status(503).json({
        error: 'Railway CLI not available in this environment',
        message: 'The pairing service cannot execute commands. Use manual pairing via Railway Terminal.'
      });
    }

    res.status(500).json({
      error: 'Pairing command failed',
      message: error.message,
      stderr: error.stderr
    });
  }
});

// List pending pairing requests
app.post('/pairing/list', authenticate, async (req, res) => {
  const { serviceId, channel } = req.body;

  if (!serviceId || typeof serviceId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid serviceId' });
  }

  if (!channel || typeof channel !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid channel' });
  }

  console.log(`[Pairing] Listing ${channel} pairing requests for service ${serviceId}`);

  try {
    const command = `openclaw pairing list ${channel}`;
    const railwayCmd = `railway run --project ${PROJECT_ID} --environment ${ENV_ID} --service ${serviceId} -- ${command}`;

    const { stdout, stderr } = await execAsync(railwayCmd, {
      timeout: 15000,
      env: {
        ...process.env,
        RAILWAY_TOKEN
      }
    });

    res.json({
      success: true,
      raw: stdout || '',
      requests: [] // Parse stdout if needed
    });

  } catch (error) {
    console.error(`[Pairing] List error:`, error.message);
    res.status(500).json({
      error: 'Failed to list pairing requests',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Pairing Service] Listening on port ${PORT}`);
  console.log(`[Pairing Service] Railway project: ${PROJECT_ID}`);
  console.log(`[Pairing Service] Environment: ${ENV_ID}`);
});
