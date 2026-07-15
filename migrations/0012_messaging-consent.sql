CREATE TABLE IF NOT EXISTS "messaging_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"channel" varchar(20) DEFAULT 'whatsapp' NOT NULL,
	"phone" varchar(24) NOT NULL,
	"consent_text" text NOT NULL,
	"source" varchar(40) DEFAULT 'web-optin' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messaging_consents_phone_idx" ON "messaging_consents" USING btree ("phone","channel");
