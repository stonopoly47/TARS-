"""TARS voice agent entrypoint (LiveKit Agents SDK)."""

import json
import logging
import os

from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
    inference,
    metrics,
)
from livekit.agents.voice import MetricsCollectedEvent
from livekit.plugins import deepgram, elevenlabs, openai, silero

from prompt import DEFAULT_HONESTY, DEFAULT_HUMOR, TARS_GREETING, build_instructions

load_dotenv()

logger = logging.getLogger("tars-agent")
logger.setLevel(logging.INFO)


def prewarm(proc: JobProcess) -> None:
    # Load the VAD model once per worker process instead of once per session.
    proc.userdata["vad"] = silero.VAD.load()


class TarsAgent(Agent):
    """TARS: deadpan military-robot persona with adjustable humor/honesty."""

    def __init__(self, ctx: JobContext) -> None:
        self._ctx = ctx
        self.humor = DEFAULT_HUMOR
        self.honesty = DEFAULT_HONESTY
        super().__init__(instructions=build_instructions(self.humor, self.honesty))

    async def on_enter(self) -> None:
        await self.session.generate_reply(instructions=TARS_GREETING)

    async def _publish_settings(self) -> None:
        payload = json.dumps(
            {"type": "tars_settings", "humor": self.humor, "honesty": self.honesty}
        ).encode("utf-8")
        try:
            await self._ctx.room.local_participant.publish_data(
                payload=payload, reliable=True, topic="tars-settings"
            )
        except Exception:
            logger.exception("failed to publish settings update")

    def _apply_settings(self) -> None:
        # Keep the LLM's system instructions in sync with the live parameter values.
        self.update_instructions(build_instructions(self.humor, self.honesty))

    @function_tool()
    async def set_humor_level(self, context: RunContext, percent: int) -> str:
        """Set TARS's humor percentage (0-100). Call this whenever the user asks to change,
        raise, lower, or set the humor setting, after resolving their request to a concrete
        target percentage.

        Args:
            percent: The new humor level from 0 to 100.
        """
        self.humor = max(0, min(100, int(percent)))
        self._apply_settings()
        await self._publish_settings()
        logger.info("humor set to %s", self.humor)
        return f"Humor set to {self.humor} percent."

    @function_tool()
    async def set_honesty_level(self, context: RunContext, percent: int) -> str:
        """Set TARS's honesty percentage (0-100). Call this whenever the user asks to change,
        raise, lower, or set the honesty setting, after resolving their request to a concrete
        target percentage.

        Args:
            percent: The new honesty level from 0 to 100.
        """
        self.honesty = max(0, min(100, int(percent)))
        self._apply_settings()
        await self._publish_settings()
        logger.info("honesty set to %s", self.honesty)
        return f"Honesty set to {self.honesty} percent."

    @function_tool()
    async def get_settings(self, context: RunContext) -> str:
        """Report TARS's current humor and honesty percentages."""
        return f"Humor is {self.humor} percent. Honesty is {self.honesty} percent."


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    session = AgentSession(
        vad=ctx.proc.userdata["vad"],
        stt=deepgram.STT(model="nova-3"),
        # Claude via OpenRouter (OpenAI-compatible API).
        llm=openai.LLM(
            model=os.getenv("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5"),
            api_key=os.getenv("OPENROUTER_API_KEY"),
            base_url="https://openrouter.ai/api/v1",
        ),
        tts=elevenlabs.TTS(
            api_key=os.getenv("ELEVENLABS_API_KEY"),
            voice_id=os.getenv("ELEVENLABS_VOICE_ID") or elevenlabs.DEFAULT_VOICE_ID,
            model=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
            # High stability + no style exaggeration keeps delivery flat and robotic
            # rather than emotionally expressive; slightly elevated speed for a
            # clipped, military cadence.
            voice_settings=elevenlabs.VoiceSettings(
                stability=0.85,
                similarity_boost=0.80,
                style=0.0,
                speed=1.05,
                use_speaker_boost=True,
            ),
        ),
        # Semantic turn detection: wait for the user to finish a complete thought before
        # replying, rather than reacting to every pause. VAD still handles instant barge-in.
        turn_detection=inference.TurnDetector(version="v1"),
        allow_interruptions=True,
    )

    @session.on("metrics_collected")
    def _on_metrics_collected(ev: MetricsCollectedEvent) -> None:
        metrics.log_metrics(ev.metrics)

    await session.start(room=ctx.room, agent=TarsAgent(ctx))


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))
