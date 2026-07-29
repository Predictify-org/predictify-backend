-- Market comments table + supporting indexes
--
-- Cursor pagination requirement:
-- Listing comments by a market must be fast and stable.
-- We sort by (created_at DESC, id DESC) and filter by market_id.

CREATE TABLE IF NOT EXISTS "market_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "market_id" text NOT NULL REFERENCES "markets"("id") ON DELETE CASCADE,

  -- Comment author (kept nullable because this endpoint is a read endpoint).
  -- If the system later adds unauthenticated posting, these can remain nullable.
  "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "author_address" text,

  -- Keep body as text (safe for read endpoint). Can be changed to jsonb later.
  "body" text NOT NULL,

  -- Moderation fields.
  "moderation_flagged" boolean NOT NULL DEFAULT false,
  "moderation_reason" text,

  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Stable keyset pagination ordering.
CREATE INDEX IF NOT EXISTS "market_comments_market_created_at_idx"
  ON "market_comments" ("market_id", "created_at" DESC, "id" DESC);

