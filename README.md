# OpenClaw Pairing Service

A microservice that executes OpenClaw pairing commands via Railway CLI.

## Deployment to Railway

1. **Create a new service** in your Railway project:
   ```
   New → Empty Service → Deploy from GitHub repo
   ```

2. **Set environment variables**:
   - `PAIRING_SERVICE_API_KEY` - Generate a random secure key (used by Next.js to authenticate)
   - `RAILWAY_TOKEN` - Your Railway API token (same as main app)
   - `RAILWAY_PROJECT_ID` - Auto-provided by Railway
   - `RAILWAY_ENVIRONMENT_ID` - Auto-provided by Railway
   - `PORT` - Auto-set by Railway (default 3001)

3. **Configure the service**:
   - Root directory: `/pairing-service`
   - Dockerfile path: `pairing-service/Dockerfile`

4. **Deploy**: Railway will auto-deploy when you push changes

## Usage from Next.js App

Update your `.env`:
```
PAIRING_SERVICE_URL=https://pairing-service.railway.app
PAIRING_SERVICE_API_KEY=<same-key-as-above>
```

Then call the service:
```typescript
const response = await fetch(`${process.env.PAIRING_SERVICE_URL}/pairing/approve`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.PAIRING_SERVICE_API_KEY}`
  },
  body: JSON.stringify({
    serviceId: 'openclaw-service-id',
    channel: 'telegram',
    code: 'PAIRING_CODE'
  })
});
```

## API Endpoints

### `GET /health`
Health check (no auth required)

### `POST /pairing/approve`
Approve a pairing request

**Headers:**
- `Authorization: Bearer <API_KEY>`

**Body:**
```json
{
  "serviceId": "railway-service-id",
  "channel": "telegram",
  "code": "PAIRING_CODE"
}
```

### `POST /pairing/list`
List pending pairing requests

**Headers:**
- `Authorization: Bearer <API_KEY>`

**Body:**
```json
{
  "serviceId": "railway-service-id",
  "channel": "telegram"
}
```
