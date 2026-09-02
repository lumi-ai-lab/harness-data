#!/usr/bin/env python3
"""Configure the runtime QwenPaw model without baking credentials into the image."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import stat
import sys


def _read_api_key(path: Path) -> str:
    try:
        info = path.lstat()
    except OSError as exc:
        raise RuntimeError(f"model API key file is unavailable: {path}: {exc}") from exc
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise RuntimeError(f"model API key must be a regular non-symlink file: {path}")
    if info.st_uid != os.geteuid() or info.st_gid != os.getegid():
        raise RuntimeError("model API key owner must match the QwenPaw process uid/gid")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("model API key permissions must be 0600 or stricter")
    try:
        from validate_runtime import _require_read_only_mount

        _require_read_only_mount(path.parent)
    except ImportError as exc:
        raise RuntimeError("runtime validator is unavailable") from exc
    key = path.read_text(encoding="utf-8").strip()
    if not key:
        raise RuntimeError("model API key file is empty")
    return key


async def _configure() -> None:
    from qwenpaw.config.config import ModelSlotConfig, load_agent_config, save_agent_config
    from qwenpaw.providers.provider import ModelInfo, ProviderInfo
    from qwenpaw.providers.provider_manager import ProviderManager

    provider_id = os.environ.get("QWENPAW_MODEL_PROVIDER_ID", "qdm-market").strip()
    model_id = os.environ.get("QWENPAW_MODEL_ID", "qwen3.8-flash").strip()
    base_url = os.environ.get("QWENPAW_MODEL_BASE_URL", "https://aig.qdama.cn/api/v1").strip()
    key_path = Path(os.environ.get("QWENPAW_MODEL_API_KEY_FILE", "/run/qwenpaw-model-secret/api-key"))
    if not provider_id or not model_id or not base_url:
        raise RuntimeError("model provider id, model id, and base URL are required")
    api_key = _read_api_key(key_path)

    manager = ProviderManager.get_instance()
    provider = manager.get_provider(provider_id)
    if provider is None:
        await manager.add_custom_provider(
            ProviderInfo(
                id=provider_id,
                name="QDM Market",
                base_url=base_url,
                chat_model="OpenAIChatModel",
                extra_models=[ModelInfo(id=model_id, name=model_id)],
            ),
        )
        provider = manager.get_provider(provider_id)
    if provider is None:
        raise RuntimeError(f"failed to create model provider: {provider_id}")
    if not provider.has_model(model_id):
        await manager.add_model_to_provider(
            provider_id=provider_id,
            model_info=ModelInfo(id=model_id, name=model_id),
        )
    if not manager.update_provider(
        provider_id,
        {
            "api_key": api_key,
            "base_url": base_url,
            "chat_model": "OpenAIChatModel",
        },
    ):
        raise RuntimeError(f"failed to persist model provider: {provider_id}")
    await manager.activate_model(provider_id, model_id)

    agent = load_agent_config("default")
    agent.active_model = ModelSlotConfig(provider_id=provider_id, model=model_id)
    save_agent_config("default", agent)
    print(f"configured QwenPaw model provider={provider_id} model={model_id}")


def main() -> int:
    try:
        asyncio.run(_configure())
    except Exception as exc:  # fail closed before the app starts
        print(f"QwenPaw model configuration failed: {exc}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
