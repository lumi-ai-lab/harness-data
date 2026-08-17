#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_ID="${1:-manual-ui-smoke}"
SESSION_DIR="$ROOT_DIR/.harness/state/html-report/$SESSION_ID"
RECOMMENDATIONS="$SESSION_DIR/recommendations.json"
source "$ROOT_DIR/scripts/agent-env.sh" >/dev/null
mkdir -p "$SESSION_DIR"
if [[ ! -f "$RECOMMENDATIONS" ]]; then
  cat > "$RECOMMENDATIONS" <<JSON
{
  "version": 1,
  "sessionId": "$SESSION_ID",
  "title": "门店101001 销售额日报 smoke",
  "mode": "free",
  "userQuestion": "生成门店101001在2026-07-26的销售额日报，按日期维度展示",
  "warnings": ["本地 smoke recommendations，由 scripts/start-local-html-report-server.sh 生成。"],
  "cards": [{
    "id": "store-101001-saleAmt-daily",
    "title": "门店101001 销售额日报",
    "headingLevel": 2,
    "analysisFocus": "按日期展示门店101001销售额，用于验证 html-report UI 到 result.json 的确认链路。",
    "chartType": "table",
    "storeCollectType": 2,
    "indicatorBizId": "localSmoke",
    "indicatorFieldList": ["saleAmt"],
    "aggDimUniqueCodeList": ["bizDate"],
    "columnAggDimUniqueCodeList": [],
    "startDate": "2026-07-26",
    "endDate": "2026-07-26",
    "filters": [{
      "type": "DIMENSION",
      "dimUniqueCode": "storeId",
      "values": ["101001"],
      "valueLabelMap": { "101001": "101001门店" }
    }]
  }]
}
JSON
fi
exec node "$ROOT_DIR/.agents/pi/skills/html-report/scripts/server.mjs" \
  --config "$RECOMMENDATIONS" \
  --session-id "$SESSION_ID" \
  --max-idle-ms 0 \
  --max-lifetime-ms 0
