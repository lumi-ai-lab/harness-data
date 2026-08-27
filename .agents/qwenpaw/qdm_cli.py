"""Narrow, shell-free qdm-metric-cli execution."""

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
SAFE_CLI_ERROR_CODES: dict[str, tuple[str, str]] = {
    "FILTER_OUTSIDE_DATA_SCOPE": (
        "QDM_FILTER_OUTSIDE_DATA_SCOPE", "请求的数据范围不在当前用户授权范围内",
    ),
    "AUTH_CAPABILITY_DENIED": (
        "QDM_AUTH_CAPABILITY_DENIED", "当前用户没有 QDM 数据查询权限",
    ),
    "EMPTY_DATA_SCOPE": (
        "QDM_EMPTY_DATA_SCOPE", "当前用户的数据授权范围为空或未配置完整",
    ),
    "AUTH_USER_DISABLED": (
        "QDM_AUTH_USER_DISABLED", "当前用户的数据授权不可用",
    ),
    "AUTH_BLOB_DECRYPT_FAIL": (
        "QDM_CHANNEL_AUTH_DENIED", "QDM 渠道授权不可用或被拒绝",
    ),
    "AUTH_BLOB_INVALID": (
        "QDM_CHANNEL_AUTH_DENIED", "QDM 渠道授权不可用或被拒绝",
    ),
    "DIMENSION_NOT_FOUND": ("QDM_DIMENSION_NOT_FOUND", "查询维度不存在"),
    "DIMENSION_NOT_SUPPORTED": ("QDM_DIMENSION_NOT_SUPPORTED", "当前指标不支持该查询维度"),
    "EMPTY_FILTER_VALUES": ("QDM_FILTER_VALUE_INVALID", "筛选值不能为空"),
    "INVALID_FILTER_VALUE": ("QDM_FILTER_VALUE_INVALID", "筛选值无效"),
    "DUPLICATE_FILTER_VALUE": ("QDM_FILTER_VALUE_INVALID", "筛选值重复"),
    "QUERY_LIMIT_EXCEEDED": ("QDM_QUERY_INVALID", "查询筛选条件超过限制"),
}
SAFE_SCOPE_DIMENSIONS: dict[str, tuple[str, str]] = {
    "manageAreaId": ("QDM_AREA_OUTSIDE_DATA_SCOPE", "请求的管理区域不在当前用户授权范围内"),
    "manageAreaIds": ("QDM_AREA_AUTH_SCOPE_EMPTY", "当前用户的管理区域授权范围为空或未配置完整"),
    "categoryLevel1Id": ("QDM_CATEGORY_OUTSIDE_DATA_SCOPE", "请求的商品分类不在当前用户授权范围内"),
    "categoryLevel1Ids": ("QDM_CATEGORY_AUTH_SCOPE_EMPTY", "当前用户的商品分类授权范围为空或未配置完整"),
    # Store authorization is optional in auth describe responses.  When the
    # upstream CLI exposes storeId entries, they are resolved exactly like
    # area/category entries; otherwise a store name is rejected fail-closed.
    "storeId": ("QDM_STORE_OUTSIDE_DATA_SCOPE", "请求的门店不在当前用户授权范围内"),
}
_SAFE_ERROR_TEXT = re.compile(
    r"(?<![A-Za-z0-9_])(?:" + "|".join(map(re.escape, SAFE_CLI_ERROR_CODES)) + r")(?![A-Za-z0-9_])",
)


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


class QdmCliExecutor:
    def __init__(self, cli_path: Path, *, success_bytes: int | None = None, timeout_seconds: int = 120) -> None:
        self._cli_path = cli_path
        self._success_bytes = success_bytes
        self._timeout_seconds = timeout_seconds

    def query(self, *, metric: str, start_date: str, end_date: str, statistic_policy: str = "SUMMARY", agg_dims: Sequence[str] | None = None, filters: Mapping[str, Sequence[str]] | None = None, time_grain: str | None = None, order_by: str | None = None, page_size: int | None = None, curr_page: int | None = None, yoy: bool = False, mom: bool = False, blob: str, scope: QueryScope | None = None) -> str:
        # Validate the business shape before touching the CLI, then perform the
        # mandatory authorization preflight before analysis execution.
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
        if scope is None:
            scope = self.preflight_query(blob)
        normalized_filters = normalize_authorized_filters(filters, scope)
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
        raw = self._run(["auth", "describe", "--auth-blob", blob])
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?") from exc
        if not isinstance(payload, Mapping):
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?")
        if payload.get("enabled") is not True:
            raise QdmCliError("QDM_AUTH_CAPABILITY_DENIED", "褰撳墠鐢ㄦ埛鐨勬暟鎹巿鏉冧笉鍙敤")
        capabilities = payload.get("capabilities")
        if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?")
        if "qdm.metric.query" not in capabilities:
            raise QdmCliError("QDM_AUTH_CAPABILITY_DENIED", "褰撳墠鐢ㄦ埛娌℃湁 QDM 鏁版嵁鏌ヨ鏉冮檺")
        if payload.get("labelsResolved") is not True:
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鏍囩鏈纭В鏋?")
        data_scope = _parse_data_scope(payload.get("dataScope"))
        if not data_scope:
            raise QdmCliError("QDM_EMPTY_DATA_SCOPE", "褰撳墠鐢ㄦ埛鐨勬暟鎹巿鏉冭寖鍥翠负绌烘垨鏈厤缃畬鏁?")
        return QueryScope(True, frozenset(capabilities), data_scope)

    def scope_summary(self, blob: str) -> dict[str, Any]:
        raw = self._run(["auth", "describe", "--auth-blob", blob])
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 权限摘要不可用") from exc
        if not isinstance(payload, dict):
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 权限摘要不可用")
        return {key: payload[key] for key in ("enabled", "capabilities", "dataScope", "labelsResolved") if key in payload}

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


def _parse_data_scope(value: Any) -> dict[str, tuple[ScopeEntry, ...]]:
    if not isinstance(value, Mapping):
        raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?")
    parsed: dict[str, tuple[ScopeEntry, ...]] = {}
    for dimension in SAFE_SCOPE_DIMENSIONS:
        raw_entries = value.get(dimension)
        if raw_entries is None:
            continue
        if not isinstance(raw_entries, Sequence) or isinstance(raw_entries, (str, bytes)):
            raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?")
        entries: list[ScopeEntry] = []
        for raw in raw_entries:
            if isinstance(raw, Mapping):
                entry_id, name = raw.get("id"), raw.get("name")
            elif isinstance(raw, str):
                entry_id = name = raw
            else:
                raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟鎹寖鍥存棤鏁?")
            if not isinstance(entry_id, str) or not entry_id.strip() or not isinstance(name, str) or not name.strip():
                raise QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 鏉冮檺鎴栨暟涓嶅畬鏁?")
            entries.append(ScopeEntry(entry_id.strip(), name.strip()))
        if entries:
            parsed[dimension] = tuple(entries)
    return parsed


def normalize_authorized_filters(filters: Mapping[str, Sequence[str]] | None, scope: QueryScope) -> dict[str, list[str]] | None:
    if filters is None:
        return None
    normalized: dict[str, list[str]] = {}
    for dimension, values in filters.items():
        if dimension not in SAFE_SCOPE_DIMENSIONS:
            normalized[dimension] = list(values)
            continue
        entries = scope.data_scope.get(dimension)
        if not entries:
            raise QdmCliError(SAFE_SCOPE_DIMENSIONS[dimension][0], SAFE_SCOPE_DIMENSIONS[dimension][1])
        result: list[str] = []
        for value in values:
            matches_by_id = [entry for entry in entries if value == entry.id]
            if matches_by_id:
                resolved = value
            else:
                matches_by_name = [entry for entry in entries if value == entry.name]
                if len(matches_by_name) == 0:
                    raise QdmCliError(SAFE_SCOPE_DIMENSIONS[dimension][0], SAFE_SCOPE_DIMENSIONS[dimension][1])
                if len(matches_by_name) > 1:
                    raise QdmCliError("QDM_FILTER_VALUE_INVALID", "绛涢€夊悕绉板尮閰嶅埌澶氫釜鎺堟潈 ID")
                resolved = matches_by_name[0].id
            if resolved in result:
                raise QdmCliError("QDM_FILTER_VALUE_INVALID", "绛涢€夊€奸噸澶?")
            result.append(resolved)
        normalized[dimension] = result
    return normalized


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _classify_cli_error(stderr: object, stdout: object) -> QdmCliError:
    """Map only allow-listed upstream codes; never expose upstream text."""
    for stream in (stderr, stdout):
        payload = _parse_json(stream)
        code = next((item for item in _json_error_codes(payload) if item in SAFE_CLI_ERROR_CODES), None)
        if code is not None:
            dimension = _json_scope_dimension(payload)
            if code == "FILTER_OUTSIDE_DATA_SCOPE" and dimension in {"manageAreaId", "categoryLevel1Id"}:
                plugin_code, message = SAFE_SCOPE_DIMENSIONS[dimension]
                return QdmCliError(plugin_code, message)
            if code == "EMPTY_DATA_SCOPE" and dimension in SAFE_SCOPE_DIMENSIONS:
                plugin_code, message = SAFE_SCOPE_DIMENSIONS[dimension]
                if plugin_code.startswith("QDM_AREA_"):
                    return QdmCliError("QDM_AREA_AUTH_SCOPE_EMPTY", message)
                return QdmCliError("QDM_CATEGORY_AUTH_SCOPE_EMPTY", message)
            plugin_code, message = SAFE_CLI_ERROR_CODES[code]
            return QdmCliError(plugin_code, message)
        code = _extract_safe_error_code(stream)
        if code is not None:
            plugin_code, message = SAFE_CLI_ERROR_CODES[code]
            return QdmCliError(plugin_code, message)
    return QdmCliError("QDM_CLI_VALIDATION_FAILED", "QDM 查询失败")


def _parse_json(value: object) -> object:
    try:
        return json.loads(str(value or ""))
    except (TypeError, json.JSONDecodeError):
        return None


def _json_scope_dimension(value: object) -> str | None:
    """Read only the documented error.details dimension/claimField fields."""
    if not isinstance(value, Mapping):
        return None
    error = value.get("error")
    if not isinstance(error, Mapping):
        return None
    details = error.get("details")
    if not isinstance(details, Mapping):
        return None
    for key in ("dimension", "claimField"):
        candidate = details.get(key)
        if isinstance(candidate, str) and candidate in SAFE_SCOPE_DIMENSIONS:
            return candidate
    return None


def _extract_safe_error_code(value: object) -> str | None:
    text = str(value or "")
    match = _SAFE_ERROR_TEXT.search(text)
    return match.group(0) if match else None


def _json_error_codes(value: object):
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "code" and isinstance(item, str):
                yield item
            yield from _json_error_codes(item)
    elif isinstance(value, list):
        for item in value:
            yield from _json_error_codes(item)


def _truncate_success(value: object, *, limit: int | None = None) -> str:
    redacted = _BLOB_PATTERN.sub("[REDACTED]", str(value or ""))
    if limit is None or len(redacted.encode("utf-8")) <= limit:
        return redacted
    raise QdmCliError("QDM_RESULT_TOO_LARGE", "鏌ヨ缁撴灉瓒呰繃閰嶇疆闄愬埗锛岃鏀圭敤鍒嗘壒鏌ヨ")
