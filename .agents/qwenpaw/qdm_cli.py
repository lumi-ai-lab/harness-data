"""Narrow, shell-free qdm-metric-cli execution.

Authorization decisions (scope, filter normalization, deny mapping) come
from ``data-harness-cli authz-hook --agent qwenpaw``; this module only
validates the business shape, forwards the query for authorization and
executes the analysis afterwards (plan.md §6).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


SENSITIVE_ENVIRONMENT = frozenset({"HARNESS_AUTH_BLOB", "HARNESS_AUTH_BLOB_FILE", "HARNESS_AUTH_USER_ID", "LUMI_REQUESTER_CONTEXT_DIR", "QDM_AUTH_BLOB", "QDM_AUTH_BLOB_FILE"})
_BLOB_PATTERN = re.compile(r"qdm1enc\.[^\s\"']+", re.IGNORECASE)
_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
_FILTER_VALUE = re.compile(r"^[^\s,=\x00]{1,128}$")
_STATISTIC_POLICIES = frozenset({"SUMMARY", "SALES_STORE_DAY_AVG"})
_TIME_GRAINS = frozenset({"DAY", "WEEK", "MONTH"})
_QUERY_KEYS = frozenset({"metric", "start_date", "end_date", "statistic_policy", "agg_dims", "filters", "time_grain", "order_by", "page_size", "curr_page", "yoy", "mom"})


class QdmCliError(RuntimeError):
    """A safe, stable failure suitable for a tool response."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ScopeEntry:
    id: str
    name: str


@dataclass(frozen=True)
class QueryScope:
    enabled: bool
    capabilities: frozenset[str]
    data_scope: Mapping[str, tuple[ScopeEntry, ...]]
    labels_resolved: bool = True


class QdmCliExecutor:
    def __init__(self, cli_path: Path, *, harness_cli: Path | None = None, success_bytes: int | None = None, timeout_seconds: int = 120) -> None:
        self._cli_path = cli_path
        self._harness_cli = harness_cli
        self._success_bytes = success_bytes
        self._timeout_seconds = timeout_seconds

    def query(self, *, metric: str, start_date: str, end_date: str, statistic_policy: str = "SUMMARY", agg_dims: Sequence[str] | None = None, filters: Mapping[str, Sequence[str]] | None = None, time_grain: str | None = None, order_by: str | None = None, page_size: int | None = None, curr_page: int | None = None, yoy: bool = False, mom: bool = False, blob: str, scope: QueryScope | None = None) -> str:
        # Validate the business shape before touching the CLI, then obtain the
        # authorized decision + normalized filters from the JS authz-hook.
        args = _query_args(
            metric=metric,
            start_date=start_date,
            end_date=end_date,
            statistic_policy=statistic_policy,
            agg_dims=agg_dims,
            filters=filters,
            time_grain=time_grain,
            order_by=order_by,
            page_size=page_size,
            curr_page=curr_page,
            yoy=yoy,
            mom=mom,
        )
        _, normalized_filters = self.authorize(blob, {
            "metric": metric,
            "start_date": start_date,
            "end_date": end_date,
            "statistic_policy": statistic_policy,
            "agg_dims": list(agg_dims) if agg_dims else None,
            "filters": dict(filters) if filters else None,
            "time_grain": time_grain,
            "order_by": order_by,
            "page_size": page_size,
            "curr_page": curr_page,
            "yoy": yoy,
            "mom": mom,
        }, scope=scope)
        args = _query_args(
            metric=metric,
            start_date=start_date,
            end_date=end_date,
            statistic_policy=statistic_policy,
            agg_dims=agg_dims,
            filters=normalized_filters,
            time_grain=time_grain,
            order_by=order_by,
            page_size=page_size,
            curr_page=curr_page,
            yoy=yoy,
            mom=mom,
        )
        return self._run(["analysis", "execute", *args, "--data-auth", "--auth-blob", blob])

    def preflight_query(self, blob: str) -> QueryScope:
        scope, _ = self.authorize(blob, {})
        return scope

    def authorize(self, blob: str, query: Mapping[str, Any], *, scope: QueryScope | None = None) -> tuple[QueryScope, dict[str, list[str]] | None]:
        """Ask the JS authz-hook for the decision, scope and normalized filters."""
        harness = self._harness_cli
        if harness is None or harness.is_symlink() or not harness.is_file() or (os.name != "nt" and not harness.stat().st_mode & stat.S_IXUSR):
            raise QdmCliError("QDM_CLI_UNAVAILABLE", "QDM CLI 不可用")
        payload = {"tool_name": "qdm_query", "tool_input": dict(query), "blob": blob}
        env = {key: value for key, value in os.environ.items() if key not in SENSITIVE_ENVIRONMENT}
        try:
            result = subprocess.run([str(harness), "authz-hook", "--agent", "qwenpaw", "--format", "adapter-envelope"], input=json.dumps(payload), cwd=str(harness.parent.parent), shell=False, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self._timeout_seconds, env=env)
        except subprocess.TimeoutExpired as exc:
            raise QdmCliError("QDM_CLI_TIMEOUT", "QDM 查询超时") from exc
        except OSError as exc:
            raise QdmCliError("QDM_CLI_UNAVAILABLE", "QDM CLI 不可用") from exc
        if result.returncode != 0:
            raise QdmCliError("QDM_AUTHZ_UNAVAILABLE", "授权服务不可用")
        try:
            envelope: Any = json.loads(result.stdout)
            status = envelope["status"]
            hook_output = envelope.get("hookOutput") or {}
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务响应无效") from exc
        if status == "disabled":
            raise QdmCliError("QDM_AUTH_CAPABILITY_DENIED", "当前用户没有 QDM 数据查询权限")
        if status == "deny":
            reason = str(hook_output.get("permissionDecisionReason") or "QDM_AUTHZ_DENIED: 请求被拒绝")
            code, _, message = reason.partition(": ")
            raise QdmCliError(code or "QDM_AUTHZ_DENIED", message or reason)
        if status != "allow":
            raise QdmCliError("QDM_AUTHZ_UNAVAILABLE", "授权服务不可用")
        decision = hook_output.get("permissionDecision")
        if decision != "allow":
            raise QdmCliError("QDM_AUTHZ_UNAVAILABLE", "授权服务不可用")
        authorized_scope = _parse_scope(hook_output.get("scope") or {}, scope)
        normalized = _parse_normalized_filters(hook_output.get("normalizedFilters"))
        return authorized_scope, normalized

    def scope_summary(self, blob: str) -> dict[str, Any]:
        scope, _ = self.authorize(blob, {})
        return {
            "enabled": scope.enabled,
            "capabilities": sorted(scope.capabilities),
            "dataScope": {k: [{"id": e.id, "name": e.name} for e in v] for k, v in scope.data_scope.items()},
            "labelsResolved": scope.labels_resolved,
        }

    def _run(self, argv: list[str]) -> str:
        if self._cli_path.is_symlink() or not self._cli_path.is_file() or (os.name != "nt" and not self._cli_path.stat().st_mode & stat.S_IXUSR):
            raise QdmCliError("QDM_CLI_UNAVAILABLE", "QDM CLI 不可用")
        env = {key: value for key, value in os.environ.items() if key not in SENSITIVE_ENVIRONMENT}
        try:
            result = subprocess.run([str(self._cli_path), *argv], cwd=str(self._cli_path.parent.parent), shell=False, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self._timeout_seconds, env=env)
        except subprocess.TimeoutExpired as exc:
            raise QdmCliError("QDM_CLI_TIMEOUT", "QDM 查询超时") from exc
        except OSError as exc:
            raise QdmCliError("QDM_CLI_UNAVAILABLE", "QDM CLI 不可用") from exc
        if result.returncode != 0:
            raise _classify_cli_error(result.stderr, result.stdout)
        return _truncate_success(result.stdout, limit=self._success_bytes)


def _query_args(*, metric: Any, start_date: Any, end_date: Any, statistic_policy: Any, agg_dims: Sequence[str] | None, filters: Mapping[str, Sequence[str]] | None, time_grain: Any, order_by: Any, page_size: Any, curr_page: Any, yoy: Any, mom: Any) -> list[str]:
    metric_value = _identifier(metric, "QDM_METRIC_INVALID", "指标代码无效")
    start = _date(start_date)
    end = _date(end_date)
    if start > end:
        raise QdmCliError("QDM_QUERY_INVALID", "查询日期范围无效")
    policy = _text(statistic_policy)
    if policy not in _STATISTIC_POLICIES:
        raise QdmCliError("QDM_QUERY_INVALID", "统计口径无效")
    dimensions = _identifiers(agg_dims, "聚合维度")
    if not isinstance(yoy, bool) or not isinstance(mom, bool):
        raise QdmCliError("QDM_QUERY_INVALID", "增长率参数无效")
    if (yoy or mom) and not dimensions:
        raise QdmCliError("QDM_QUERY_INVALID", "增长率查询必须指定聚合维度")

    args = ["--start-date", start.isoformat(), "--end-date", end.isoformat(), "--metric", metric_value]
    for dimension in dimensions:
        args.extend(("--agg-dim", dimension))
    args.extend(("--statistic-policy", policy))
    for dimension, values in _filters(filters):
        args.extend(("--filter", f"{dimension}={','.join(values)}"))
    if time_grain is not None:
        grain = _text(time_grain)
        if grain not in _TIME_GRAINS:
            raise QdmCliError("QDM_QUERY_INVALID", "时间粒度无效")
        args.extend(("--time-grain", grain))
    if order_by is not None:
        order = _text(order_by)
        if not order or len(order) > 128 or "\x00" in order:
            raise QdmCliError("QDM_QUERY_INVALID", "排序参数无效")
        args.extend(("--order-by", order))
    for flag, value in (("--page-size", page_size), ("--curr-page", curr_page)):
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 500:
                raise QdmCliError("QDM_QUERY_INVALID", "分页参数无效")
            args.extend((flag, str(value)))
    if yoy:
        args.append("--yoy")
    if mom:
        args.append("--mom")
    # Output shaping is plugin-owned, so model arguments cannot alter it.
    args.extend(("--format", "json", "--output", "envelope"))
    return args


def _date(value: Any) -> dt.date:
    text = _text(value)
    try:
        return dt.date.fromisoformat(text)
    except ValueError as exc:
        raise QdmCliError("QDM_QUERY_INVALID", "查询日期无效") from exc


def _identifier(value: Any, code: str, message: str) -> str:
    text = _text(value)
    if not _IDENTIFIER.fullmatch(text):
        raise QdmCliError(code, message)
    return text


def _identifiers(values: Any, field: str) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        raise QdmCliError("QDM_QUERY_INVALID", f"{field}无效")
    result = [_identifier(value, "QDM_QUERY_INVALID", f"{field}无效") for value in values]
    if len(result) != len(set(result)):
        raise QdmCliError("QDM_QUERY_INVALID", f"{field}重复")
    return result


def _filters(value: Any) -> list[tuple[str, list[str]]]:
    if value is None:
        return []
    if not isinstance(value, Mapping):
        raise QdmCliError("QDM_FILTER_INVALID", "筛选条件无效")
    result: list[tuple[str, list[str]]] = []
    for raw_dimension, raw_values in value.items():
        dimension = _identifier(raw_dimension, "QDM_FILTER_INVALID", "筛选维度无效")
        if not isinstance(raw_values, Sequence) or isinstance(raw_values, (str, bytes)) or not raw_values:
            raise QdmCliError("QDM_FILTER_INVALID", "筛选值无效")
        values = [_text(item) for item in raw_values]
        if any(not _FILTER_VALUE.fullmatch(item) for item in values) or len(values) != len(set(values)):
            raise QdmCliError("QDM_FILTER_INVALID", "筛选值无效")
        result.append((dimension, values))
    return result


def _parse_scope(value: Any, cached: QueryScope | None) -> QueryScope:
    if cached is not None:
        return cached
    if not isinstance(value, Mapping):
        raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务响应无效")
    enabled = value.get("enabled") is True
    capabilities_raw = value.get("capabilities")
    if not isinstance(capabilities_raw, list) or not all(isinstance(item, str) for item in capabilities_raw):
        raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务响应无效")
    data_scope = _parse_data_scope(value.get("dataScope"))
    labels_resolved = value.get("labelsResolved") is not False
    return QueryScope(enabled, frozenset(capabilities_raw), data_scope, labels_resolved)


def _parse_normalized_filters(value: Any) -> dict[str, list[str]] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务响应无效")
    parsed: dict[str, list[str]] = {}
    for dimension, values in value.items():
        if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
            raise QdmCliError("QDM_AUTHZ_PROTOCOL_INVALID", "授权服务响应无效")
        parsed[str(dimension)] = values
    return parsed


def _parse_data_scope(value: Any) -> dict[str, tuple[ScopeEntry, ...]]:
    if not isinstance(value, Mapping):
        return {}
    parsed: dict[str, tuple[ScopeEntry, ...]] = {}
    for dimension, raw_entries in value.items():
        if not isinstance(raw_entries, Sequence) or isinstance(raw_entries, (str, bytes)):
            continue
        entries: list[ScopeEntry] = []
        for raw in raw_entries:
            if isinstance(raw, Mapping):
                entry_id, name = raw.get("id"), raw.get("name")
            elif isinstance(raw, str):
                entry_id = name = raw
            else:
                continue
            if not isinstance(entry_id, str) or not entry_id.strip() or not isinstance(name, str):
                continue
            entries.append(ScopeEntry(entry_id.strip(), name.strip()))
        if entries:
            parsed[str(dimension)] = tuple(entries)
    return parsed


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _truncate_success(value: str, limit: int | None = None) -> str:
    redacted = _BLOB_PATTERN.sub("[REDACTED]", str(value or ""))
    if limit is None:
        return redacted
    if len(redacted) > limit:
        raise QdmCliError("QDM_RESULT_TOO_LARGE", "QDM 查询结果过大")
    return redacted


def _classify_cli_error(stderr: object, stdout: object) -> QdmCliError:
    """Fail closed: execute-time errors never surface upstream text or rule tables.

    Authorization decisions and their codes come from the JS authz-hook before
    execution; a non-zero execute exit is surfaced as a safe generic error.
    """
    del stderr, stdout
    return QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 查询失败")
