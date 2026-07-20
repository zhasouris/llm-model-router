"""
RouteLLM signal sidecar (ADR 0006).

A persistent Python service that loads a trained RouteLLM router once at startup
and answers the win-rate (P the strong model is needed) for a prompt — WITHOUT
calling any model. The TypeScript proxy calls this over localhost HTTP via the
RouteLLMProvider. See docs/decisions/0006-leveraging-learned-routing.md.

Env:
  ROUTELLM_ROUTER        router type (default: mf)
  ROUTELLM_STRONG_MODEL  strong model id for Controller init (not called)
  ROUTELLM_WEAK_MODEL    weak model id for Controller init (not called)
  OPENAI_API_KEY         used by the mf router for prompt embeddings
"""

import os

import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel
from routellm.controller import Controller

ROUTER = os.getenv("ROUTELLM_ROUTER", "mf")
STRONG = os.getenv("ROUTELLM_STRONG_MODEL", "gpt-4-1106-preview")
WEAK = os.getenv("ROUTELLM_WEAK_MODEL", "anyscale/mistralai/Mixtral-8x7B-Instruct-v0.1")

app = FastAPI(title="routellm-sidecar")
_controller: Controller | None = None


class ScoreRequest(BaseModel):
    prompt: str


@app.on_event("startup")
def _load() -> None:
    global _controller
    # Weights auto-download from HuggingFace on first init.
    _controller = Controller(routers=[ROUTER], strong_model=STRONG, weak_model=WEAK)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok" if _controller is not None else "loading", "router": ROUTER}


@app.post("/score")
def score(req: ScoreRequest) -> dict:
    assert _controller is not None, "controller not loaded"
    win = float(
        _controller.batch_calculate_win_rate(
            prompts=pd.Series([req.prompt]), router=ROUTER
        ).iloc[0]
    )
    return {"winRate": win, "confidence": abs(win - 0.5) * 2, "router": ROUTER}
