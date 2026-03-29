ALTER TABLE "issues" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "issues_metadata_idx" ON "issues" USING gin ("metadata");