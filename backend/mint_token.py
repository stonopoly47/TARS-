"""Mint a LiveKit room access token for the TARS frontend to connect with.

Usage:
    python mint_token.py [room] [identity] [ttl_hours]
"""

import sys
from datetime import timedelta

from dotenv import load_dotenv
from livekit import api

load_dotenv()

room = sys.argv[1] if len(sys.argv) > 1 else "tars-room"
identity = sys.argv[2] if len(sys.argv) > 2 else "commander"
ttl_hours = float(sys.argv[3]) if len(sys.argv) > 3 else 6

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
    .with_ttl(timedelta(hours=ttl_hours))
    .to_jwt()
)

print(token)
