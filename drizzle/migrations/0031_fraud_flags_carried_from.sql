ALTER TABLE "fraud_flags" ADD COLUMN IF NOT EXISTS "carried_from" uuid REFERENCES "fraud_flags"("id") ON DELETE SET NULL;
