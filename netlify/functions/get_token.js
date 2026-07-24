const { AccessToken, RoomConfiguration, RoomAgentDispatch } = require('livekit-server-sdk');

const DEFAULT_ROOM = 'tars-room';

// Minimal in-memory rate limit. Netlify Functions are stateless per-invocation
// but a warm container can serve several requests in a row, so this at least
// blunts rapid-fire retries from a single leaked PIN within a warm window -
// it is not a substitute for a real distributed rate limiter.
const attempts = new Map(); // ip -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

exports.handler = async (event) => {
  const ip = event.headers?.['x-nf-client-connection-ip'] || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Too many requests. Try again in a minute.' }),
    };
  }

  const params = event.queryStringParameters || {};

  const requiredPin = process.env.ACCESS_PIN;
  if (requiredPin && params.pin !== requiredPin) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid or missing passcode.' }),
    };
  }

  const room = params.room || DEFAULT_ROOM;
  const identity = params.identity || `user-${Math.random().toString(36).slice(2, 10)}`;

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity,
    name: identity,
    ttl: '6h',
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  // Explicitly lists TARS as the room's agent so whichever client connects
  // gets it dispatched reliably (mirrors backend/mint_token.py).
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: '' })],
  });

  const token = await at.toJwt();

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ url: process.env.LIVEKIT_URL, token }),
  };
};
