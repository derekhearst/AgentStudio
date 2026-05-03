CREATE TABLE "context_slot_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"slot_name" text NOT NULL,
	"token_budget" integer,
	"priority" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_slot_configs_user_agent_slot_unique" UNIQUE("user_id","agent_id","slot_name")
);
--> statement-breakpoint
ALTER TABLE "context_slot_configs" ADD CONSTRAINT "context_slot_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_slot_configs" ADD CONSTRAINT "context_slot_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_slot_configs_user_idx" ON "context_slot_configs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "context_slot_configs_agent_idx" ON "context_slot_configs" USING btree ("agent_id");