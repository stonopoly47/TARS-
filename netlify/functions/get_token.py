"""Netlify Function: mints a LiveKit access token for the TARS frontend.

The token's RoomConfiguration explicitly lists TARS as the room's agent, so
whichever client connects gets it dispatched reliably and only once per room
(mirrors backend/mint_token.py, the CLI equivalent used for manual testing).
"""

import json
import os
import secrets
from datetime import timedelta

from livekit import api

DEFAULT_ROOM = "tars-room"


def handler(event, context):
    params = event.get("queryStringParameters") or {}
    room = params.get("room") or DEFAULT_ROOM
    identity = params.get("identity") or f"user-{secrets.token_hex(4)}"

    token = (
        api.AccessToken()
        .with_identity(identity)
        .with_name(identity)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .with_room_config(
            api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name="")])
        )
        .with_ttl(timedelta(hours=6))
        .to_jwt()
    )

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps({"url": os.environ["LIVEKIT_URL"], "token": token}),
    }
