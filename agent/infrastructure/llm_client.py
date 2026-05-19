"""Multi-provider OpenAI-compatible LLM client.

Ports bb-pm-tools/src/infrastructure/llm-client.ts. Supports the providers
declared in config (default / gemini / openrouter / 9router), retries
transient failures, and exposes a single `chat()` primitive used by the
check-in parser, NL-to-SQL translator and tool layer.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from core.config import LlmProviderConfig, settings
from core.logging import log_event


class LlmTransientError(RuntimeError):
    """Raised for retryable upstream failures (5xx, connection drops)."""


class LlmError(RuntimeError):
    """Raised for non-retryable LLM failures (4xx, malformed response)."""


class ChatResponse:
    __slots__ = ("content", "tool_calls", "finish_reason", "usage", "latency_ms", "provider", "model")

    def __init__(
        self,
        content: Optional[str],
        tool_calls: list[dict[str, Any]],
        finish_reason: str,
        usage: Optional[dict[str, Any]] = None,
        latency_ms: int = 0,
        provider: str = "",
        model: str = "",
    ) -> None:
        self.content = content
        self.tool_calls = tool_calls
        self.finish_reason = finish_reason
        self.usage = usage
        self.latency_ms = latency_ms
        self.provider = provider
        self.model = model


_RETRYABLE = (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
              httpx.RemoteProtocolError, LlmTransientError)


class LlmClient:
    def __init__(self) -> None:
        self._clients: dict[str, httpx.AsyncClient] = {}

    def _client(self, provider: str, cfg: LlmProviderConfig) -> httpx.AsyncClient:
        if provider not in self._clients:
            headers = {"Content-Type": "application/json"}
            if cfg.api_key and cfg.api_key not in ("not-needed", "nokey"):
                headers["Authorization"] = f"Bearer {cfg.api_key}"
            self._clients[provider] = httpx.AsyncClient(
                base_url=cfg.base_url,
                timeout=httpx.Timeout(330.0, connect=10.0),
                headers=headers,
            )
        return self._clients[provider]

    async def close(self) -> None:
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        *,
        provider: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        response_format: Optional[dict[str, str]] = None,
    ) -> ChatResponse:
        name = provider or settings.llm.active_provider
        cfg = settings.llm.providers.get(name)
        if cfg is None:
            raise LlmError(f"Unknown LLM provider: {name}")
        if name in {"gemini", "openrouter"} and not cfg.api_key:
            raise LlmError(f"LLM provider '{name}' missing API key")

        body: dict[str, Any] = {
            "model": cfg.model,
            "messages": messages,
            "max_tokens": max_tokens if max_tokens is not None else cfg.max_tokens,
            "temperature": temperature if temperature is not None else cfg.temperature,
            "stream": False,
        }
        if response_format:
            body["response_format"] = response_format
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        return await self._chat_with_retry(name, cfg, body)

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1.5, min=1.5, max=6),
        reraise=True,
    )
    async def _chat_with_retry(
        self, name: str, cfg: LlmProviderConfig, body: dict[str, Any]
    ) -> ChatResponse:
        import time

        client = self._client(name, cfg)
        t0 = time.monotonic()
        try:
            res = await client.post("/chat/completions", json=body)
        except _RETRYABLE as err:
            log_event("llm.transient", level="warning", provider=name, error=str(err))
            raise
        if res.status_code >= 500:
            log_event("llm.upstream_5xx", level="warning", provider=name, status=res.status_code)
            raise LlmTransientError(f"LLM {res.status_code}: {res.text[:300]}")
        if res.status_code >= 400:
            raise LlmError(f"LLM {res.status_code}: {res.text[:300]}")

        data = res.json()
        choice = (data.get("choices") or [None])[0]
        if not choice:
            raise LlmError("LLM returned no choices")
        message = choice.get("message") or {}
        return ChatResponse(
            content=message.get("content"),
            tool_calls=message.get("tool_calls") or [],
            finish_reason=choice.get("finish_reason") or "stop",
            usage=data.get("usage"),
            latency_ms=int((time.monotonic() - t0) * 1000),
            provider=name,
            model=cfg.model,
        )
