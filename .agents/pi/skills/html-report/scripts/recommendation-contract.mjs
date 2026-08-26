const LEGACY_TIME_DIMENSION_RE = new RegExp(`^inc(?:${["D(?:ate|ay)", "Week", "Month", "Year"].join("|")})$`);

function inspectCode(value, path, errors) {
  const code = String(value ?? "").trim();
  if (LEGACY_TIME_DIMENSION_RE.test(code)) {
    errors.push(`${path}: legacy time dimension ${code} is not allowed; use bizDate from qdm-metric-cli Registry`);
  }
}

function inspectCodeList(value, path, errors) {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) inspectCode(item, `${path}[${index}]`, errors);
}

function inspectFilterDim(filter, path, errors) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return;
  for (const key of ["dimUniqueCode", "dim_unique_code"]) {
    if (filter[key] != null) inspectCode(filter[key], `${path}.${key}`, errors);
  }
}

function inspectFilterMap(filters, path, errors) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return;
  for (const key of Object.keys(filters)) inspectCode(key, `${path}.${key}`, errors);
}

export function collectRecommendationContractErrors(data) {
  const errors = [];
  for (const [cardIndex, card] of (Array.isArray(data?.cards) ? data.cards : []).entries()) {
    if (!card || typeof card !== "object" || Array.isArray(card)) continue;
    const prefix = `cards[${cardIndex}]`;
    inspectCodeList(card.aggDimUniqueCodeList, `${prefix}.aggDimUniqueCodeList`, errors);
    inspectCodeList(card.columnAggDimUniqueCodeList, `${prefix}.columnAggDimUniqueCodeList`, errors);
    for (const [filterIndex, filter] of (Array.isArray(card.filters) ? card.filters : []).entries()) {
      inspectFilterDim(filter, `${prefix}.filters[${filterIndex}]`, errors);
    }
    if (card.requestBody && typeof card.requestBody === "object" && !Array.isArray(card.requestBody)) {
      inspectCodeList(card.requestBody.aggDimUniqueCodeList, `${prefix}.requestBody.aggDimUniqueCodeList`, errors);
      inspectCodeList(card.requestBody.columnAggDimUniqueCodeList, `${prefix}.requestBody.columnAggDimUniqueCodeList`, errors);
      for (const [filterIndex, filter] of (Array.isArray(card.requestBody.filterDimUniqueCodeList) ? card.requestBody.filterDimUniqueCodeList : []).entries()) {
        inspectFilterDim(filter, `${prefix}.requestBody.filterDimUniqueCodeList[${filterIndex}]`, errors);
      }
    }
    const queryRequest = card.query?.request;
    if (queryRequest && typeof queryRequest === "object" && !Array.isArray(queryRequest)) {
      inspectCodeList(queryRequest.dimensions, `${prefix}.query.request.dimensions`, errors);
      inspectFilterMap(queryRequest.filters, `${prefix}.query.request.filters`, errors);
    }
  }
  return errors;
}
