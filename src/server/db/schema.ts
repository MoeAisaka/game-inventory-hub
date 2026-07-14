import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const auditOutcome = pgEnum("audit_outcome", ["SUCCESS", "FAILURE"]);
export const fileStatus = pgEnum("file_status", ["STAGED", "READY", "MISSING"]);
export const importBatchStatus = pgEnum("import_batch_status", [
  "PENDING",
  "PARSED",
  "VALIDATED",
  "COMMITTED",
  "ROLLED_BACK",
  "FAILED"
]);
export const importRowStatus = pgEnum("import_row_status", ["PENDING", "SUCCESS", "WARNING", "ERROR", "EXCLUDED"]);
export const migrationRecordType = pgEnum("migration_record_type", ["GAME", "ASSET", "INVENTORY"]);
export const gamePlayStatus = pgEnum("game_play_status", [
  "BACKLOG",
  "PLAYING",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
  "UNPLANNED"
]);
export const gameRecordStatus = pgEnum("game_record_status", [
  "BACKLOG",
  "PLAYING",
  "PAUSED",
  "COMPLETED",
  "ABANDONED",
  "UNPLANNED",
  "UNRELEASED",
  "TO_BUY"
]);
export const dataSource = pgEnum("data_source", [
  "MANUAL",
  "IMPORT",
  "STEAM",
  "IGDB",
  "RAWG",
  "HLTB",
  "WIKIDATA",
  "STEAMGRIDDB",
  "PLAYSTATION",
  "NINTENDO"
]);
export const gameRatingSource = pgEnum("game_rating_source", [
  "MANUAL",
  "STEAM",
  "IGDB",
  "RAWG",
  "METACRITIC",
  "IGN",
  "XIAOHEIHE"
]);
export const externalProvider = pgEnum("external_provider", [
  "STEAM",
  "IGDB",
  "RAWG",
  "HLTB",
  "WIKIDATA",
  "STEAMGRIDDB",
  "PLAYSTATION",
  "NINTENDO"
]);
export const externalAccountStatus = pgEnum("external_account_status", ["ACTIVE", "DISABLED", "ERROR"]);
export const syncJobStatus = pgEnum("sync_job_status", ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]);
export const steamLibraryMatchStatus = pgEnum("steam_library_match_status", ["MATCHED", "UNMATCHED", "IGNORED"]);
export const gameMetadataField = pgEnum("game_metadata_field", [
  "NAME_ZH",
  "NAME_EN",
  "COVER_URL",
  "RELEASE_DATE",
  "COMMUNITY_RATING",
  "CRITIC_RATING",
  "MAIN_STORY_MINUTES",
  "EXTRA_STORY_MINUTES",
  "COMPLETIONIST_MINUTES"
]);
export const metadataCandidateStatus = pgEnum("metadata_candidate_status", ["PENDING", "APPLIED", "REJECTED", "STALE"]);
export const assetStatus = pgEnum("asset_status", ["ACTIVE", "SOLD", "DISCARDED"]);
export const inventoryMovementType = pgEnum("inventory_movement_type", [
  "PURCHASE",
  "OPENED",
  "CONSUMED",
  "DISCARDED",
  "GIFTED",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "ADJUSTMENT"
]);

export type ImportIssue = {
  code: string;
  message: string;
  severity: "WARNING" | "ERROR";
  field?: string;
};

const createdAt = () => timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, precision: 3 }).defaultNow().notNull();

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("users_username_key").on(table.username),
  check("users_username_normalized", sql`${table.username} = lower(${table.username})`),
  check("users_username_length", sql`char_length(${table.username}) BETWEEN 3 AND 64`)
]);

export const userPreferences = pgTable("user_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("user_preferences_owner_namespace_key").on(table.ownerUserId, table.namespace),
  check("user_preferences_namespace_length", sql`char_length(${table.namespace}) BETWEEN 3 AND 100`)
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("sessions_token_hash_key").on(table.tokenHash),
  index("sessions_user_active_idx").on(table.userId, table.expiresAt),
  check("sessions_token_hash_sha256", sql`char_length(${table.tokenHash}) = 64`)
]);

export const authLoginAttempts = pgTable("auth_login_attempts", {
  keyHash: text("key_hash").primaryKey(),
  failedCount: integer("failed_count").default(0).notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true, precision: 3 }),
  updatedAt: updatedAt()
}, (table) => [
  check("auth_attempt_key_hash_sha256", sql`char_length(${table.keyHash}) = 64`),
  check("auth_attempt_failed_nonnegative", sql`${table.failedCount} >= 0`)
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  outcome: auditOutcome("outcome").notNull(),
  requestId: text("request_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt()
}, (table) => [
  index("audit_logs_created_at_idx").on(table.createdAt),
  index("audit_logs_entity_idx").on(table.entityType, table.entityId),
  check("audit_logs_action_length", sql`char_length(${table.action}) BETWEEN 3 AND 100`),
  check("audit_logs_request_id_length", sql`char_length(${table.requestId}) BETWEEN 8 AND 100`)
]);

export const fileBlobs = pgTable("file_blobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  checksumSha256: text("checksum_sha256").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  storagePath: text("storage_path"),
  status: fileStatus("status").default("STAGED").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("file_blobs_checksum_key").on(table.checksumSha256),
  check("file_blobs_checksum_sha256", sql`char_length(${table.checksumSha256}) = 64`),
  check("file_blobs_size_nonnegative", sql`${table.byteSize} >= 0`)
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  blobId: uuid("blob_id").notNull().references(() => fileBlobs.id, { onDelete: "restrict" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("attachments_entity_blob_key").on(table.entityType, table.entityId, table.blobId),
  index("attachments_entity_idx").on(table.entityType, table.entityId, table.sortOrder),
  check("attachments_sort_order_nonnegative", sql`${table.sortOrder} >= 0`)
]);

export const importBatches = pgTable("import_batches", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceName: text("source_name").notNull(),
  sourceChecksum: text("source_checksum").notNull(),
  sourceByteSize: bigint("source_byte_size", { mode: "number" }).notNull(),
  status: importBatchStatus("status").default("PENDING").notNull(),
  totalRows: integer("total_rows").default(0).notNull(),
  successRows: integer("success_rows").default(0).notNull(),
  warningRows: integer("warning_rows").default(0).notNull(),
  errorRows: integer("error_rows").default(0).notNull(),
  excludedRows: integer("excluded_rows").default(0).notNull(),
  imageRefCount: integer("image_ref_count").default(0).notNull(),
  uniqueMediaCount: integer("unique_media_count").default(0).notNull(),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("import_batches_source_checksum_key").on(table.sourceChecksum),
  index("import_batches_status_created_idx").on(table.status, table.createdAt),
  check("import_batches_checksum_sha256", sql`char_length(${table.sourceChecksum}) = 64`),
  check("import_batches_size_nonnegative", sql`${table.sourceByteSize} >= 0`),
  check("import_batches_counts_nonnegative", sql`
    ${table.totalRows} >= 0 AND ${table.successRows} >= 0 AND ${table.warningRows} >= 0 AND ${table.errorRows} >= 0
    AND ${table.excludedRows} >= 0 AND ${table.imageRefCount} >= 0 AND ${table.uniqueMediaCount} >= 0
  `),
  check("import_batches_counts_within_total", sql`
    ${table.successRows} + ${table.warningRows} + ${table.errorRows} + ${table.excludedRows} <= ${table.totalRows}
  `)
]);

export const importRows = pgTable("import_rows", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  sheetName: text("sheet_name").notNull(),
  sourceRow: integer("source_row").notNull(),
  recordType: migrationRecordType("record_type").notNull(),
  rowChecksum: text("row_checksum").notNull(),
  status: importRowStatus("status").default("PENDING").notNull(),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().default({}).notNull(),
  normalizedPayload: jsonb("normalized_payload").$type<Record<string, unknown>>(),
  issues: jsonb("issues").$type<ImportIssue[]>().default([]).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("import_rows_batch_sheet_row_key").on(table.batchId, table.sheetName, table.sourceRow),
  index("import_rows_batch_status_idx").on(table.batchId, table.status),
  check("import_rows_source_row_positive", sql`${table.sourceRow} > 0`),
  check("import_rows_checksum_sha256", sql`char_length(${table.rowChecksum}) = 64`)
]);

export const importImageRefs = pgTable("import_image_refs", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  sheetName: text("sheet_name").notNull(),
  sourceRow: integer("source_row").notNull(),
  sourceColumn: integer("source_column").notNull(),
  anchorIndex: integer("anchor_index").notNull(),
  mediaPath: text("media_path").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  extension: text("extension").notNull(),
  status: importRowStatus("status").default("SUCCESS").notNull(),
  issues: jsonb("issues").$type<ImportIssue[]>().default([]).notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("import_image_refs_anchor_key").on(
    table.batchId,
    table.sheetName,
    table.sourceRow,
    table.sourceColumn,
    table.anchorIndex
  ),
  index("import_image_refs_batch_checksum_idx").on(table.batchId, table.checksumSha256),
  check("import_image_refs_row_positive", sql`${table.sourceRow} > 0`),
  check("import_image_refs_column_positive", sql`${table.sourceColumn} > 0`),
  check("import_image_refs_anchor_nonnegative", sql`${table.anchorIndex} >= 0`),
  check("import_image_refs_checksum_sha256", sql`char_length(${table.checksumSha256}) = 64`),
  check("import_image_refs_size_positive", sql`${table.byteSize} > 0`)
]);

export const importReconciliations = pgTable("import_reconciliations", {
  id: uuid("id").defaultRandom().primaryKey(),
  batchId: uuid("batch_id").notNull().references(() => importBatches.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  expectedCount: integer("expected_count").notNull(),
  actualCount: integer("actual_count").notNull(),
  passed: boolean("passed").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("import_reconciliations_batch_metric_key").on(table.batchId, table.metric),
  index("import_reconciliations_batch_passed_idx").on(table.batchId, table.passed),
  check("import_reconciliations_counts_nonnegative", sql`${table.expectedCount} >= 0 AND ${table.actualCount} >= 0`),
  check("import_reconciliations_metric_length", sql`char_length(${table.metric}) BETWEEN 3 AND 100`)
]);

export const games = pgTable("games", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  nameZh: text("name_zh").notNull(),
  nameEn: text("name_en"),
  nameEnSource: dataSource("name_en_source").default("IMPORT").notNull(),
  notes: text("notes"),
  platform: text("platform"),
  platformSource: text("platform_source"),
  mediaType: text("media_type"),
  ownershipStatus: text("ownership_status"),
  handheldBest: boolean("handheld_best"),
  proEnhanced: boolean("pro_enhanced"),
  controllerFeatures: text("controller_features"),
  modRequired: boolean("mod_required").default(false).notNull(),
  priorityLevel: integer("priority_level"),
  priorityRank: text("priority_rank"),
  queueOrder: integer("queue_order"),
  repeatable: boolean("repeatable").default(false).notNull(),
  releaseDate: date("release_date"),
  releaseDateSource: dataSource("release_date_source").default("IMPORT").notNull(),
  communityRating: numeric("community_rating", { precision: 5, scale: 2, mode: "number" }),
  communityRatingCount: integer("community_rating_count"),
  criticRating: numeric("critic_rating", { precision: 5, scale: 2, mode: "number" }),
  criticRatingCount: integer("critic_rating_count"),
  ratingSource: gameRatingSource("rating_source"),
  ratingUpdatedAt: timestamp("rating_updated_at", { withTimezone: true, precision: 3 }),
  playStatus: gamePlayStatus("play_status"),
  startedAt: date("started_at"),
  completedAt: date("completed_at"),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true, precision: 3 }),
  progressPercent: integer("progress_percent"),
  playtimeMinutesManual: integer("playtime_minutes_manual"),
  playtimeMinutesSynced: integer("playtime_minutes_synced").default(0).notNull(),
  estimatedHastilyMinutes: integer("estimated_hastily_minutes"),
  estimatedNormallyMinutes: integer("estimated_normally_minutes"),
  estimatedCompletelyMinutes: integer("estimated_completely_minutes"),
  coverUrl: text("cover_url"),
  coverUrlSource: dataSource("cover_url_source"),
  firstObservedPlayedAt: timestamp("first_observed_played_at", { withTimezone: true, precision: 3 }),
  playtimeLastChangedAt: timestamp("playtime_last_changed_at", { withTimezone: true, precision: 3 }),
  steamAppId: integer("steam_app_id"),
  igdbGameId: integer("igdb_game_id"),
  igdbLastAttemptAt: timestamp("igdb_last_attempt_at", { withTimezone: true, precision: 3 }),
  acquisitionNotes: text("acquisition_notes"),
  sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
  sourceRow: integer("source_row"),
  version: integer("version").default(1).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("games_import_source_key").on(table.sourceBatchId, table.sourceRow),
  uniqueIndex("games_owner_steam_app_key").on(table.ownerUserId, table.steamAppId),
  index("games_owner_name_idx").on(table.ownerUserId, table.nameZh),
  index("games_owner_status_idx").on(table.ownerUserId, table.playStatus),
  index("games_owner_platform_idx").on(table.ownerUserId, table.platform),
  index("games_owner_deleted_idx").on(table.ownerUserId, table.deletedAt),
  check("games_name_length", sql`char_length(${table.nameZh}) BETWEEN 1 AND 200`),
  check("games_priority_level_range", sql`${table.priorityLevel} IS NULL OR ${table.priorityLevel} BETWEEN 0 AND 5`),
  check("games_priority_rank_value", sql`${table.priorityRank} IS NULL OR ${table.priorityRank} IN ('A', 'B')`),
  check("games_queue_order_range", sql`${table.queueOrder} IS NULL OR ${table.queueOrder} BETWEEN 1 AND 9999`),
  check("games_rating_range", sql`
    (${table.communityRating} IS NULL OR ${table.communityRating} BETWEEN 0 AND 100)
    AND (${table.criticRating} IS NULL OR ${table.criticRating} BETWEEN 0 AND 100)
  `),
  check("games_rating_counts_nonnegative", sql`
    (${table.communityRatingCount} IS NULL OR ${table.communityRatingCount} >= 0)
    AND (${table.criticRatingCount} IS NULL OR ${table.criticRatingCount} >= 0)
  `),
  check("games_progress_range", sql`${table.progressPercent} IS NULL OR ${table.progressPercent} BETWEEN 0 AND 100`),
  check("games_playtime_nonnegative", sql`
    (${table.playtimeMinutesManual} IS NULL OR ${table.playtimeMinutesManual} >= 0)
    AND ${table.playtimeMinutesSynced} >= 0
  `),
  check("games_estimates_nonnegative", sql`
    (${table.estimatedHastilyMinutes} IS NULL OR ${table.estimatedHastilyMinutes} >= 0)
    AND (${table.estimatedNormallyMinutes} IS NULL OR ${table.estimatedNormallyMinutes} >= 0)
    AND (${table.estimatedCompletelyMinutes} IS NULL OR ${table.estimatedCompletelyMinutes} >= 0)
  `),
  check("games_date_order", sql`${table.startedAt} IS NULL OR ${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`),
  check("games_version_positive", sql`${table.version} > 0`)
]);

export const gameStatusAssignments = pgTable("game_status_assignments", {
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  status: gameRecordStatus("status").notNull(),
  createdAt: createdAt()
}, (table) => [
  primaryKey({ name: "game_status_assignments_pkey", columns: [table.gameId, table.status] }),
  index("game_status_assignments_status_game_idx").on(table.status, table.gameId)
]);

export const gamePlaySessions = pgTable("game_play_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true, precision: 3 }),
  minutes: integer("minutes").notNull(),
  source: dataSource("source").default("MANUAL").notNull(),
  notes: text("notes"),
  createdAt: createdAt()
}, (table) => [
  index("game_play_sessions_game_started_idx").on(table.gameId, table.startedAt),
  check("game_play_sessions_minutes_positive", sql`${table.minutes} > 0`),
  check("game_play_sessions_date_order", sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`)
]);

export const externalAccounts = pgTable("external_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: externalProvider("provider").notNull(),
  externalUserId: text("external_user_id").notNull(),
  displayName: text("display_name"),
  status: externalAccountStatus("status").default("ACTIVE").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, precision: 3 }),
  lastErrorCode: text("last_error_code"),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("external_accounts_owner_provider_key").on(table.ownerUserId, table.provider),
  check("external_accounts_user_id_length", sql`char_length(${table.externalUserId}) BETWEEN 1 AND 200`)
]);

export const externalGameMappings = pgTable("external_game_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: externalProvider("provider").notNull(),
  externalGameId: text("external_game_id").notNull(),
  matchConfidence: integer("match_confidence").default(100).notNull(),
  manuallyConfirmed: boolean("manually_confirmed").default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("external_game_mappings_provider_external_key").on(table.provider, table.externalGameId),
  index("external_game_mappings_game_provider_idx").on(table.gameId, table.provider),
  check("external_game_mappings_confidence_range", sql`${table.matchConfidence} BETWEEN 0 AND 100`)
]);

export const gameFieldLocks = pgTable("game_field_locks", {
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  field: gameMetadataField("field").notNull(),
  lockedByUserId: uuid("locked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt()
}, (table) => [
  primaryKey({ name: "game_field_locks_pkey", columns: [table.gameId, table.field] })
]);

export const gameMetadataCandidates = pgTable("game_metadata_candidates", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: dataSource("provider").notNull(),
  externalGameId: text("external_game_id").notNull(),
  field: gameMetadataField("field").notNull(),
  value: jsonb("value").$type<{ value: unknown; sourceUrl?: string; sourceLabel?: string }>().notNull(),
  confidence: integer("confidence").default(0).notNull(),
  status: metadataCandidateStatus("status").default("PENDING").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("game_metadata_candidates_source_field_key").on(
    table.gameId,
    table.provider,
    table.externalGameId,
    table.field
  ),
  index("game_metadata_candidates_owner_status_idx").on(table.ownerUserId, table.status, table.fetchedAt),
  check("game_metadata_candidates_confidence_range", sql`${table.confidence} BETWEEN 0 AND 100`)
]);

export const gameRatings = pgTable("game_ratings", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  source: gameRatingSource("source").notNull(),
  kind: text("kind").notNull(),
  score: numeric("score", { precision: 5, scale: 2, mode: "number" }).notNull(),
  ratingCount: integer("rating_count"),
  sourceUrl: text("source_url"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("game_ratings_game_source_kind_key").on(table.gameId, table.source, table.kind),
  index("game_ratings_owner_source_idx").on(table.ownerUserId, table.source),
  check("game_ratings_kind_value", sql`${table.kind} IN ('COMMUNITY', 'CRITIC')`),
  check("game_ratings_score_range", sql`${table.score} BETWEEN 0 AND 100`),
  check("game_ratings_count_nonnegative", sql`${table.ratingCount} IS NULL OR ${table.ratingCount} >= 0`)
]);

export const gameAcquisitions = pgTable("game_acquisitions", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  source: dataSource("source").notNull(),
  externalAcquisitionId: text("external_acquisition_id"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true, precision: 3 }),
  isOwned: boolean("is_owned").default(true).notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("game_acquisitions_source_external_key").on(
    table.ownerUserId,
    table.source,
    table.externalAcquisitionId
  ),
  index("game_acquisitions_game_owned_idx").on(table.gameId, table.isOwned),
  check("game_acquisitions_external_id_length", sql`${table.externalAcquisitionId} IS NULL OR char_length(${table.externalAcquisitionId}) BETWEEN 1 AND 300`)
]);

export const gameActivitySnapshots = pgTable("game_activity_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
  provider: externalProvider("provider").notNull(),
  externalGameId: text("external_game_id").notNull(),
  totalPlaytimeMinutes: integer("total_playtime_minutes").default(0).notNull(),
  recentPlaytimeMinutes: integer("recent_playtime_minutes"),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true, precision: 3 }),
  observedAt: timestamp("observed_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("game_activity_snapshots_observation_key").on(
    table.ownerUserId,
    table.provider,
    table.externalGameId,
    table.observedAt
  ),
  index("game_activity_snapshots_game_observed_idx").on(table.gameId, table.observedAt),
  check("game_activity_snapshots_playtime_nonnegative", sql`
    ${table.totalPlaytimeMinutes} >= 0
    AND (${table.recentPlaytimeMinutes} IS NULL OR ${table.recentPlaytimeMinutes} >= 0)
  `)
]);

export const gameReleaseEvents = pgTable("game_release_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").references(() => games.id, { onDelete: "cascade" }),
  source: dataSource("source").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  externalGameId: text("external_game_id"),
  nameZh: text("name_zh").notNull(),
  nameEn: text("name_en"),
  platform: text("platform").notNull(),
  releaseDate: date("release_date").notNull(),
  region: text("region").default("GLOBAL").notNull(),
  isAnnounced: boolean("is_announced").default(true).notNull(),
  storeUrl: text("store_url"),
  coverUrl: text("cover_url"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("game_release_events_owner_dedupe_key").on(table.ownerUserId, table.dedupeKey),
  index("game_release_events_owner_date_idx").on(table.ownerUserId, table.releaseDate, table.platform),
  check("game_release_events_name_length", sql`char_length(${table.nameZh}) BETWEEN 1 AND 300`),
  check("game_release_events_platform_length", sql`char_length(${table.platform}) BETWEEN 1 AND 100`),
  check("game_release_events_dedupe_length", sql`char_length(${table.dedupeKey}) BETWEEN 3 AND 500`)
]);

export const syncJobs = pgTable("sync_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: externalProvider("provider").notNull(),
  status: syncJobStatus("status").default("PENDING").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  cursor: text("cursor"),
  processedCount: integer("processed_count").default(0).notNull(),
  createdCount: integer("created_count").default(0).notNull(),
  updatedCount: integer("updated_count").default(0).notNull(),
  skippedCount: integer("skipped_count").default(0).notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }),
  completedAt: timestamp("completed_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("sync_jobs_owner_idempotency_key").on(table.ownerUserId, table.idempotencyKey),
  index("sync_jobs_owner_created_idx").on(table.ownerUserId, table.createdAt),
  check("sync_jobs_counts_nonnegative", sql`
    ${table.processedCount} >= 0 AND ${table.createdCount} >= 0 AND ${table.updatedCount} >= 0 AND ${table.skippedCount} >= 0
  `),
  check("sync_jobs_idempotency_length", sql`char_length(${table.idempotencyKey}) BETWEEN 8 AND 200`)
]);

export const steamLibraryItems = pgTable("steam_library_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  steamAppId: integer("steam_app_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  playtimeMinutes: integer("playtime_minutes").default(0).notNull(),
  recentPlaytimeMinutes: integer("recent_playtime_minutes"),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true, precision: 3 }),
  iconUrl: text("icon_url"),
  matchStatus: steamLibraryMatchStatus("match_status").default("UNMATCHED").notNull(),
  matchedGameId: uuid("matched_game_id").references(() => games.id, { onDelete: "set null" }),
  matchConfidence: integer("match_confidence").default(0).notNull(),
  matchMethod: text("match_method").notNull(),
  isOwned: boolean("is_owned").default(true).notNull(),
  lastSeenJobId: uuid("last_seen_job_id").references(() => syncJobs.id, { onDelete: "set null" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("steam_library_items_owner_app_key").on(table.ownerUserId, table.steamAppId),
  index("steam_library_items_owner_status_idx").on(table.ownerUserId, table.matchStatus, table.isOwned),
  index("steam_library_items_matched_game_idx").on(table.matchedGameId),
  check("steam_library_items_app_id_positive", sql`${table.steamAppId} > 0`),
  check("steam_library_items_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 300`),
  check("steam_library_items_playtime_nonnegative", sql`
    ${table.playtimeMinutes} >= 0
    AND (${table.recentPlaytimeMinutes} IS NULL OR ${table.recentPlaytimeMinutes} >= 0)
  `),
  check("steam_library_items_confidence_range", sql`${table.matchConfidence} BETWEEN 0 AND 100`),
  check("steam_library_items_match_invariant", sql`
    (${table.matchStatus} = 'MATCHED' AND ${table.matchedGameId} IS NOT NULL)
    OR (${table.matchStatus} <> 'MATCHED' AND ${table.matchedGameId} IS NULL)
  `)
]);

export const assets = pgTable("assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
  categoryLarge: text("category_large"),
  categorySmall: text("category_small"),
  assetName: text("asset_name").notNull(),
  parentNameSource: text("parent_name_source"),
  purchasedAt: date("purchased_at"),
  purchaseChannel: text("purchase_channel"),
  purchasePrice: numeric("purchase_price", { precision: 12, scale: 2 }),
  saleIncome: numeric("sale_income", { precision: 12, scale: 2 }),
  status: assetStatus("status").default("ACTIVE").notNull(),
  notes: text("notes"),
  sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
  sourceRow: integer("source_row"),
  deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("assets_import_source_key").on(table.sourceBatchId, table.sourceRow),
  index("assets_owner_name_idx").on(table.ownerUserId, table.assetName),
  index("assets_parent_idx").on(table.parentId),
  check("assets_name_length", sql`char_length(${table.assetName}) BETWEEN 1 AND 300`),
  check("assets_prices_nonnegative", sql`
    (${table.purchasePrice} IS NULL OR ${table.purchasePrice} >= 0)
    AND (${table.saleIncome} IS NULL OR ${table.saleIncome} >= 0)
  `)
]);

export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  productName: text("product_name").notNull(),
  priorityCode: text("priority_code"),
  brand: text("brand"),
  style: text("style"),
  denier: text("denier"),
  color: text("color").notNull(),
  colorSource: text("color_source"),
  material: text("material"),
  composition: text("composition"),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
  unopenedQuantity: integer("unopened_quantity").default(0).notNull(),
  openedQuantity: integer("opened_quantity").default(0).notNull(),
  notes: text("notes"),
  repurchaseDecision: text("repurchase_decision"),
  repurchaseSource: text("repurchase_source"),
  currentLocation: text("current_location"),
  sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
  sourceRow: integer("source_row"),
  deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
  version: integer("version").default(1).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, (table) => [
  uniqueIndex("inventory_items_import_source_key").on(table.sourceBatchId, table.sourceRow),
  index("inventory_items_owner_name_idx").on(table.ownerUserId, table.productName),
  check("inventory_items_name_length", sql`char_length(${table.productName}) BETWEEN 1 AND 300`),
  check("inventory_items_quantity_nonnegative", sql`${table.unopenedQuantity} >= 0 AND ${table.openedQuantity} >= 0`),
  check("inventory_items_unit_price_nonnegative", sql`${table.unitPrice} IS NULL OR ${table.unitPrice} >= 0`),
  check("inventory_items_version_positive", sql`${table.version} > 0`)
]);

export const inventoryMovements = pgTable("inventory_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  movementType: inventoryMovementType("movement_type").notNull(),
  unopenedDelta: integer("unopened_delta").default(0).notNull(),
  openedDelta: integer("opened_delta").default(0).notNull(),
  reason: text("reason"),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  sourceBatchId: uuid("source_batch_id").references(() => importBatches.id, { onDelete: "restrict" }),
  createdAt: createdAt()
}, (table) => [
  index("inventory_movements_item_created_idx").on(table.itemId, table.createdAt),
  check("inventory_movements_nonzero", sql`${table.unopenedDelta} <> 0 OR ${table.openedDelta} <> 0`)
]);
