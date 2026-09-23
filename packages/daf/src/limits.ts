/**
 * Size and count caps on a DAF (arch v1.3 §18.5 rule 1 and rule 5).
 *
 * The caps exist for two different reasons and it helps to keep them apart:
 *
 *   - The string caps are the same numbers the server-side extract prompt
 *     already enforces (`zExtractedEntry`), so an entry from either origin
 *     fits the same columns and the same Inbox card.
 *   - The count caps are about an untrusted input (C8). A DAF is produced by
 *     a model reading the user's own conversation, and a conversation can say
 *     "emit ten thousand entries". Excess is dropped and counted in the
 *     validation report; the batch still lands.
 */
export const DAF_LIMITS = {
  /** Whole document, as received. The web route refuses larger bodies. */
  maxBytes: 5 * 1024 * 1024,

  titleMax: 200,
  bodyMax: 4000,
  topicMax: 200,
  summaryMax: 2000,
  doingNowMax: 600,
  blockerMax: 300,
  artifactPathMax: 400,
  rejectedOptionMax: 300,
  entityRefMax: 120,
  labelMax: 40,
  /** Note pages (2026-10-04). A section body fits a long table; the page as a whole stays under the DAF byte cap. */
  pageTitleMax: 200,
  pageSummaryMax: 2000,
  sectionHeadingMax: 200,
  sectionBodyMax: 8000,
  sectionsPerPage: 40,
  refMax: 200,
  /** runs.content_hash: 64 hex chars normally, or `<adapter_id>:<run_ref>` when a run carried none. */
  hashMax: 300,

  /** Anchors per entry: the same 1–12 the server prompt allows. */
  anchorsPerEntry: 12,
  rejectedOptionsPerEntry: 8,
  entitiesPerEntry: 16,
  labelsPerSegment: 8,
  blockersPerState: 8,
  artifactsPerState: 12,
  sourceRunsPerState: 20,

  /** Count caps, applied after schema validation (rule 5). */
  entriesPerRun: 60,
  entriesTotal: 2000,
  segmentsPerRun: 100,
  segmentsTotal: 3000,
  agentStatesTotal: 50,
  /** One page per run: a second page for the same run is dropped, not merged. */
  pagesPerRun: 1,
  pagesTotal: 200,

  /** Dropped items listed in the report, so the report itself stays small. */
  reportDroppedMax: 200,
} as const;
