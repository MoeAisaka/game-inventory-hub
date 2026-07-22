-- PlayStation snapshots cannot reliably distinguish digital purchases, discs, and Plus access.
-- Apply the owner-approved historical fallback only to rows that have never been classified.
UPDATE "game_acquisitions"
SET "channel" = 'SUBSCRIPTION'::"game_acquisition_channel",
    "availability" = 'AVAILABLE'::"game_acquisition_availability",
    "offline_capable" = false,
    "is_owned" = false,
    "details" = coalesce("details", '{}'::jsonb) || jsonb_build_object(
      'classificationMode', 'PLATFORM_FALLBACK',
      'classificationBasis', 'PLAYSTATION_SOURCE_CANNOT_RELIABLY_DISTINGUISH_PURCHASE_DISC_PLUS',
      'defaultChannel', 'SUBSCRIPTION'
    ),
    "last_confirmed_at" = now(),
    "updated_at" = now(),
    "version" = "version" + 1
WHERE "source" = 'PLAYSTATION'
  AND "channel" IS NULL;

-- Nintendo played-title snapshots do not expose a reliable physical/digital ownership source.
-- Create one default physical acquisition for every matched historical item. Manual edits use the
-- same row and are preserved by future snapshot ingestion.
INSERT INTO "game_acquisitions" (
  "owner_user_id", "game_id", "source", "external_acquisition_id", "channel", "platform",
  "availability", "offline_capable", "is_owned", "details", "last_confirmed_at"
)
SELECT item."owner_user_id", item."matched_game_id", 'NINTENDO', item."external_game_id",
       'PHYSICAL'::"game_acquisition_channel", coalesce(item."platform", game."platform"),
       'AVAILABLE'::"game_acquisition_availability", true, true,
       jsonb_build_object(
         'classificationMode', 'PLATFORM_FALLBACK',
         'classificationBasis', 'NINTENDO_SOURCE_CANNOT_RELIABLY_DISTINGUISH_DIGITAL_PHYSICAL',
         'defaultChannel', 'PHYSICAL'
       ),
       item."last_seen_at"
FROM "platform_library_items" AS item
JOIN "games" AS game ON game."id" = item."matched_game_id"
WHERE item."provider" = 'NINTENDO'
  AND item."matched_game_id" IS NOT NULL
  AND game."deleted_at" IS NULL
ON CONFLICT ("owner_user_id", "source", "external_acquisition_id") DO NOTHING;

-- Wishlist and to-buy are now one product queue. Keep the nullable column for backwards
-- compatibility with older imports, but remove the active distinction from existing data.
UPDATE "platform_wishlist_items"
SET "plan_order" = NULL,
    "updated_at" = now()
WHERE "is_active" = true
  AND "plan_order" IS NOT NULL;

-- Retain the legacy enum value for API compatibility while canonicalising persisted game statuses.
INSERT INTO "game_status_assignments" ("game_id", "status", "created_at")
SELECT "game_id", 'TO_BUY'::"game_record_status", "created_at"
FROM "game_status_assignments"
WHERE "status" = 'WISHLIST'
ON CONFLICT ("game_id", "status") DO NOTHING;

DELETE FROM "game_status_assignments" WHERE "status" = 'WISHLIST';
