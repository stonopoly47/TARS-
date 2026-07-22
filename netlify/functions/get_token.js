const { AccessToken, RoomConfiguration, RoomAgentDispatch } = require('livekit-server-sdk');

const DEFAULT_ROOM = 'tars-room';

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
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
