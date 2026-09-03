#!/usr/bin/env python3
"""容器启动时自动配置 QwenPaw 的 LLM 模型连接,无需在后台手动配置。

由 entrypoint.sh 在每次容器启动时调用:从 QWENPAW_MODEL_API_KEY 环境变量
读取 API key,注册 OpenAI 兼容提供商 qdm-market,添加并激活模型,再把 QDM
专用 Agent(``QWENPAW_QDM_AGENT_ID``,默认 harness-data-default)的
active_model 指向该模型。密钥因此不会烧进镜像。任何一步失败都返回退出码
78,在 QwenPaw 主进程启动前快速失败。
"""

from __future__ import annotations

import asyncio
import os
import sys


async def _configure() -> None:
    from qwenpaw.config.config import (
        ModelSlotConfig,
        load_agent_config,
        save_agent_config,
    )
    from qwenpaw.providers.provider import ModelInfo, ProviderInfo
    from qwenpaw.providers.provider_manager import ProviderManager

    provider_id = os.environ.get("QWENPAW_MODEL_PROVIDER_ID", "qdm-market").strip()
    model_id = os.environ.get("QWENPAW_MODEL_ID", "qwen3.8-flash").strip()
    base_url = os.environ.get(
        "QWENPAW_MODEL_BASE_URL", "https://aig.qdama.cn/api/v1"
    ).strip()
    if not provider_id or not model_id or not base_url:
        raise RuntimeError("model provider id, model id, and base URL are required")
    api_key = os.environ.get("QWENPAW_MODEL_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("QWENPAW_MODEL_API_KEY is required")

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

    agent_id = os.environ.get("QWENPAW_QDM_AGENT_ID", "harness-data-default").strip() or "harness-data-default"
    agent = load_agent_config(agent_id)
    agent.active_model = ModelSlotConfig(provider_id=provider_id, model=model_id)
    save_agent_config(agent_id, agent)
    print(f"configured QwenPaw model provider={provider_id} model={model_id} agent={agent_id}")


def main() -> int:
    try:
        asyncio.run(_configure())
    except Exception as exc:  # fail closed before the app starts
        print(f"QwenPaw model configuration failed: {exc}", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
