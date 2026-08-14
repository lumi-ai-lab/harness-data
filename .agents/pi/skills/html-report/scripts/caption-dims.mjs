/**
 * Dimension catalog and drill axis for first-pass card captions.
 *
 * Only dimensions that appear in card.query.request.dimensions participate.
 * Unknown codes, including totalArea and bizDate/bizWeek/bizMonth, are dropped.
 */
export const CAPTION_DIM_GROUPS = Object.freeze([
  Object.freeze({
    id: "date",
    dims: Object.freeze(["bizDate", "bizWeek", "bizMonth", "bizYear"]),
  }),
  Object.freeze({
    id: "store",
    dims: Object.freeze([
      "sapArea2Id",
      "manageAreaId",
      "sapAreaId",
      "cityId",
      "zoneManagerId",
      "groupManagerId",
      "storeId",
    ]),
  }),
  Object.freeze({
    id: "sku",
    dims: Object.freeze([
      "categoryLevel1Id",
      "categoryLevel2Id",
      "categoryLevel3Id",
      "spuId",
      "articleId",
    ]),
  }),
  Object.freeze({
    id: "salesBusiness",
    dims: Object.freeze(["saleModeId"]),
  }),
  Object.freeze({
    id: "dc",
    dims: Object.freeze(["dcSapArea2Id", "dcManageAreaId", "dcCityId", "dcId"]),
  }),
  Object.freeze({
    id: "purchaseDepartment",
    dims: Object.freeze([
      "superiorPurchaseDepartmentId",
      "purchaseDepartmentId",
      "purchaseGroupId",
      "matnrId",
      "purchaseArticleId",
    ]),
  }),
  Object.freeze({
    id: "cmrValidStore",
    dims: Object.freeze(["cmrValidStoreId"]),
  }),
]);

export const CAPTION_AXIS_LIMIT = 3;
export const CAPTION_GROUP_LIMIT = 3;
export const CAPTION_DIMS_PER_GROUP = 3;

const DIM_INDEX = new Map();
for (const [groupIndex, group] of CAPTION_DIM_GROUPS.entries()) {
  for (const [dimIndex, dim] of group.dims.entries()) {
    DIM_INDEX.set(dim, { groupId: group.id, groupIndex, dimIndex });
  }
}

export function captionDimLocation(dim) {
  return DIM_INDEX.get(String(dim || "")) || null;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const item of value) {
    const dim = String(item || "").trim();
    if (!dim || seen.has(dim)) continue;
    seen.add(dim);
    items.push(dim);
  }
  return items;
}

/**
 * Build the at-most-3-step fixed-head drill axis from a query's row dimensions.
 */
export function buildCaptionAxis(dimensions) {
  const requested = uniqueStrings(dimensions);
  const dropped = [];
  const byGroup = new Map();
  for (const dim of requested) {
    const location = captionDimLocation(dim);
    if (!location) {
      dropped.push(dim);
      continue;
    }
    const bucket = byGroup.get(location.groupId) || [];
    bucket.push({ dim, dimIndex: location.dimIndex });
    byGroup.set(location.groupId, bucket);
  }

  const presentGroups = CAPTION_DIM_GROUPS.filter((group) => byGroup.has(group.id));
  const keptGroups = presentGroups.slice(0, CAPTION_GROUP_LIMIT);
  for (const group of presentGroups.slice(CAPTION_GROUP_LIMIT)) {
    for (const item of byGroup.get(group.id) || []) dropped.push(item.dim);
  }

  const flattened = [];
  for (const group of keptGroups) {
    const ranked = [...(byGroup.get(group.id) || [])].sort((left, right) => left.dimIndex - right.dimIndex);
    const kept = ranked.slice(0, CAPTION_DIMS_PER_GROUP);
    for (const item of ranked.slice(CAPTION_DIMS_PER_GROUP)) dropped.push(item.dim);
    for (const item of kept) flattened.push(item.dim);
  }

  const axis = flattened.slice(0, CAPTION_AXIS_LIMIT);
  dropped.push(...flattened.slice(CAPTION_AXIS_LIMIT));
  return {
    axis,
    droppedDimensions: dropped,
    groups: keptGroups.map((group) => group.id),
  };
}

export function captionPrefixes(axis) {
  const dims = Array.isArray(axis) ? axis.filter((item) => typeof item === "string" && item) : [];
  return dims.map((_, index) => dims.slice(0, index + 1));
}

export function captionViewId(kind, metric, prefix) {
  const safeKind = String(kind || "").trim();
  const safeMetric = String(metric || "").trim();
  const suffix = (Array.isArray(prefix) ? prefix : []).join("+");
  if (!safeKind || !safeMetric || !suffix) {
    throw new Error("caption view id requires kind, metric, and a non-empty prefix");
  }
  return `${safeKind}-${safeMetric}-${suffix}`;
}
