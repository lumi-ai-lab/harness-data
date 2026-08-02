import importlib.util
import os
import sys
from pathlib import Path


def load_hooks(source: Path):
    spec = importlib.util.spec_from_file_location("qdm_harness_hooks_e2e", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Hermes hooks from {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: hermes-hooks-e2e.py <workspace> <hooks.py>")
    workspace = Path(sys.argv[1]).resolve()
    hooks = load_hooks(Path(sys.argv[2]).resolve())
    os.chdir(workspace)

    session_id = "native-hermes-report"
    context = hooks.pre_llm_call({
        "session_id": session_id,
        "prompt": "请生成经营综合分析报告",
    })
    if "Harness mode: report" not in str(context.get("context", "")):
        raise AssertionError(f"Hermes context Hook did not run the native CLI: {context!r}")

    executable = workspace / "bin" / (
        "data-harness-cli.exe" if os.name == "nt" else "data-harness-cli"
    )
    command = (
        f'& "{executable}" stage template'
        if os.name == "nt"
        else f"'{executable}' stage template"
    )
    posttool = hooks.post_tool_call({
        "session_id": session_id,
        "tool_name": "terminal",
        "tool_input": {"command": command},
    })
    if "QDM_FINAL_OUTPUT_CONTRACT" not in str(posttool.get("context", "")):
        raise AssertionError(f"Hermes post-tool Hook did not run the native CLI: {posttool!r}")

    print("Hermes native Hook E2E passed")


if __name__ == "__main__":
    main()
