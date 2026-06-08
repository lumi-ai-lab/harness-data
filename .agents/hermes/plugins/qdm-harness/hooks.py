import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict

JsonObject = Dict[str, Any]


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _find_project_root(start_dir: str | None = None) -> Path:
    current = Path(start_dir or os.getcwd()).resolve()
    while True:
        if (current / "bin" / "data-harness-cli").exists():
            return current
        if (current / ".agents").exists() and (current / "wikis").exists():
            return current
        if current.parent == current:
            return Path(__file__).resolve().parents[4]
        current = current.parent


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def _latest_user_prompt(event: Any) -> str:
    if isinstance(event, str):
        return event.strip()
    if not _is_object(event):
        return ""
    for key in ("prompt", "input", "text", "message"):
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    messages = event.get("messages") if isinstance(event.get("messages"), list) else []
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = _content_text(message.get("content")).strip()
        if text:
            return text
    return ""


def _session_id(event: Any) -> str:
    if _is_object(event):
        for key in ("session_id", "sessionId", "conversation_id", "threadId"):
            value = event.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return os.environ.get("HERMES_SESSION_ID") or os.environ.get("CLAUDE_SESSION_ID") or "unknown"


def _extract_context(output: str) -> str:
    if not output.strip():
        return ""
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        return ""
    context = None
    if isinstance(payload, dict):
        hook_output = payload.get("hookSpecificOutput")
        if isinstance(hook_output, dict):
            context = hook_output.get("additionalContext")
        context = context or payload.get("additionalContext") or payload.get("context")
    return context.strip() if isinstance(context, str) else ""


def _run_cli(project_root: Path, args: list[str], payload: JsonObject) -> str:
    result = subprocess.run(
        [str(project_root / "bin" / "data-harness-cli"), *args],
        cwd=project_root,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return ""
    return _extract_context(result.stdout)


def _tool_name(event: Any) -> str:
    if not _is_object(event):
        return ""
    for key in ("tool_name", "toolName", "name", "type"):
        value = event.get(key)
        if isinstance(value, str):
            return value
    return ""


def _tool_input(event: Any) -> JsonObject:
    if not _is_object(event):
        return {}
    for key in ("tool_input", "toolInput", "input", "arguments", "args"):
        value = event.get(key)
        if isinstance(value, dict):
            return value
    return event


def _command(event: Any) -> str:
    value = _tool_input(event).get("command")
    return value if isinstance(value, str) else ""


def _is_template_command(command: str) -> bool:
    return "data-harness-cli" in command and ("inject-template" in command or "stage template" in command)


def pre_llm_call(event: Any, _context: Any = None) -> JsonObject:
    prompt = _latest_user_prompt(event)
    if not prompt:
        return {}
    project_root = _find_project_root()
    context = _run_cli(project_root, ["context", "--format", "agent-hook"], {
        "session_id": _session_id(event),
        "prompt": prompt,
    })
    return {"context": context} if context else {}


def post_tool_call(event: Any, _context: Any = None) -> JsonObject:
    name = _tool_name(event).lower()
    command = _command(event)
    if name not in {"bash", "shell", "terminal", "exec"} or not _is_template_command(command):
        return {}
    project_root = _find_project_root()
    context = _run_cli(project_root, ["posttool", "--format", "agent-hook"], {
        "session_id": _session_id(event),
        "tool_name": "Bash",
        "tool_input": {"command": command},
    })
    return {"context": context} if context else {}
