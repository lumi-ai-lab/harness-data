.PHONY: plugin plugin-init plugin-init-codex-dev plugin-init-qwenpaw-dev init codex dex dev marketplace-zip plugin-pack

VERSION ?= $(shell node -p "require('./plugins/harness-data/.codex-plugin/plugin.json').version")
MARKETPLACE_NAME := harness-data-codex-marketplace
MARKETPLACE_ZIP := dist/$(MARKETPLACE_NAME)-v$(VERSION).zip
MARKETPLACE_DIR := dist/$(MARKETPLACE_NAME)

PLUGIN_HOST ?= codex
PLUGIN_PROFILE ?= dev

# Initialize the local Plugin against this repository and run the installed
# Plugin setup.  PLUGIN_HOST selects the host: codex or qwenpaw.
plugin: plugin-init-codex-dev

# Keep the documented multi-target spelling useful without creating duplicate
# initialization runs.
init codex dex dev: plugin-init-codex-dev

plugin-init:
	@if [ "$(PLUGIN_HOST)" = "codex" ]; then \
		node scripts/plugin-dev-init.mjs; \
	elif [ "$(PLUGIN_HOST)" = "qwenpaw" ]; then \
		node scripts/plugin-dev-init-qwenpaw.mjs; \
	else \
		echo "unsupported PLUGIN_HOST: $(PLUGIN_HOST)"; exit 1; \
	fi

plugin-init-codex-dev:
	@$(MAKE) plugin-init PLUGIN_HOST=codex PLUGIN_PROFILE=dev

plugin-init-qwenpaw-dev:
	@$(MAKE) plugin-init PLUGIN_HOST=qwenpaw PLUGIN_PROFILE=dev

# Build the public Codex Marketplace ZIP locally (includes dist/, excludes wikis).
plugin-pack: marketplace-zip

marketplace-zip:
	@mkdir -p dist
	@node plugins/harness-data/scripts/bundle-dist.mjs --output-dir plugins/harness-data/dist
	@node scripts/build-codex-marketplace.mjs pack --zip "$(CURDIR)/$(MARKETPLACE_ZIP)" --version "$(VERSION)"
	@rm -rf "$(MARKETPLACE_DIR)"
	@unzip -q "$(MARKETPLACE_ZIP)" -d dist
	@test ! -e "$(MARKETPLACE_DIR)/plugins/harness-data/resources/wikis"
	@test -f "$(MARKETPLACE_DIR)/.agents/plugins/marketplace.json"
	@test -f "$(MARKETPLACE_DIR)/plugins/harness-data/dist/data-harness-cli/src/main.js"
	@printf '%s\n' \
		'' \
		'Marketplace ZIP：' \
		'  $(CURDIR)/$(MARKETPLACE_ZIP)' \
		'' \
		'解压后的 Marketplace：' \
		'  $(CURDIR)/$(MARKETPLACE_DIR)' \
		'' \
		'安装：' \
		'  codex plugin marketplace add "$(CURDIR)/$(MARKETPLACE_DIR)"' \
		'  codex plugin add harness-data@lumi-ai-lab' \
		'' \
		'  Setup 必须在真实项目目录执行，不要把 plugin cache 当成工作区：' \
		'    PLUGIN_ROOT="$${CODEX_HOME:-$$HOME/.codex}/plugins/cache/lumi-ai-lab/harness-data/$(VERSION)"' \
		'    node "$$PLUGIN_ROOT/scripts/setup.mjs" --workspace-allowlist "$$PWD"' \
		'' \
		'  --workspace-allowlist 是要启用本插件的项目路径。' \
		'  不能是 $$CODEX_HOME/plugins、plugin cache 或 dataRoot。' \
		'  可重复传入多个项目；目录不存在时会创建。' \
		'  Setup 完成后需要开一个新的 Codex 会话。' \
		'' \
		'  Setup 仍会下载私有 Wikis 和 qdm-metric-cli。本地覆盖示例：' \
		'    node "$$PLUGIN_ROOT/scripts/setup.mjs" \' \
		'      --workspace-allowlist "$$PWD" \' \
		'      --wikis-source /Users/pengmd/c/qdm/harness-data-wikis \' \
		'      --metric-cli /path/to/qdm-metric-cli' \
		'' \
		'卸载：' \
		'  codex plugin remove harness-data@lumi-ai-lab' \
		'  codex plugin marketplace remove lumi-ai-lab' \
		'' \
		'  以上命令会删除 Codex plugin cache 并取消 Marketplace 注册。' \
		'  不会删除 $$CODEX_HOME/qdm-harness/data，也不会删除项目里的 .codex/config.toml。' \
		''

