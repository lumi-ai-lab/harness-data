export {
  DEFAULT_METRIC_PAGE_SIZE,
  normalizeMetricQuery,
  metricQueryFromCard,
  metricCliPayload,
  metricComparisonArgs,
} from "./query/metric-query-contract.mjs";
export {
  fetchAllEntries,
  parseEntryMetaResponse,
  reusableEntry,
  rowsSha256,
  columnMetaPathFor,
  buildColumnLabels,
  normalizeEntryPayload,
} from "./data/fetch-entry.mjs";
export {
  canonicalQueryJson,
  reusableExplore,
  semanticQueryShape,
  materialQueryDelta,
  computeQueryPatch,
  applyQueryPatch,
  sanitizeTaskId,
  fetchExploreTask,
} from "./data/fetch-explore.mjs";
export {
  WRITER_ACK_TOOL,
  WRITER_CAPTION_TOOL,
  sanitizeCardId,
  writerReturnPaths,
  buildWriterReturnSchema,
  captionPathFor,
  extractWriterReceipt,
  parseWriterReturnText,
  validateWriterReturn,
} from "./session/writer-return.mjs";
export {
  CAPTION_DIM_GROUPS,
  CAPTION_AXIS_LIMIT,
  CAPTION_GROUP_LIMIT,
  CAPTION_DIMS_PER_GROUP,
  captionDimLocation,
  buildCaptionAxis,
  sortDimensionColumns,
  captionPrefixes,
  captionViewId,
  dimensionLabelColumn,
  resolveDimensionColumn,
} from "./evidence/caption-dims.mjs";
export {
  CAPTION_EVIDENCE_PRODUCER,
  CAPTION_N,
  CAPTION_COMPARISON_SUFFIXES,
  captionNumber,
  buildCaptionEvidence,
  persistCaptionEvidence,
  prepareCardCaptionEvidence,
} from "./evidence/prepare-card-caption-evidence.mjs";
export {
  MIN_JOINT_CELL_SUPPORT,
  canonicalizeJson,
  compactDecisionQueryScope,
  EvidenceFieldValidationError,
  validateEvidenceFieldReferences,
  buildSourceFieldMetadata,
  executeEvidenceOperations,
  prepareSourceFieldInventory,
  preparePendingReuseEvidence,
  prepareResearchEvidence,
} from "./evidence/prepare-research-evidence.mjs";
export {
  EDITOR_SOURCE_INVENTORY_CACHE_VERSION,
  EDITOR_SOURCE_INVENTORY_CACHE_PRODUCER,
  persistEditorSourceInventory,
} from "./editor/source-inventory-cache.mjs";
export {
  CAPTION_POINTER_PATTERN,
  CAPTION_MAX_PARAGRAPHS,
  CAPTION_MAX_PARAGRAPH_CHARS,
  captionPointerBudget,
  canonicalizeCaptionPointer,
  captionViewPointer,
  parseJsonArrayField,
  defaultCaptionPointers,
  validateCaptionSubmission,
  writeCardCaption,
} from "./captions/submit-card-caption.mjs";
export {
  sanitizeId,
  extractRows,
  rowsToMarkdown,
  assembleReport,
} from "./artifacts/assemble-report.mjs";
export { renderFirstMain, composeMain } from "./artifacts/compose-main.mjs";
export {
  MAIN_HTML_PRODUCER,
  MAIN_HTML_META_VERSION,
  MAIN_HTML_THEME,
  MAIN_HTML_RENDERER,
  DEFAULT_MAIN_HTML_TIMEOUT_MS,
  htmlExportSummary,
  exportMainHtml,
} from "./artifacts/export-main-html.mjs";
export {
  EVIDENCE_GAP_TYPES,
  isJsonObject,
  evidenceGapTypes,
  isValidEvidenceGap,
  evidenceGapMatchesChangedKeys,
} from "./contracts/research-contract.mjs";
