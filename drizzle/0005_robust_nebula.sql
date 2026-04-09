CREATE TYPE "public"."hall_type" AS ENUM('facts', 'events', 'discoveries', 'preferences', 'advice');--> statement-breakpoint
CREATE TABLE "memory_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wing_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_closet" boolean DEFAULT false NOT NULL,
	"closet_for_room_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_wings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "wing_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "hall_type" "hall_type" DEFAULT 'discoveries' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "is_closet" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "closet_for_room_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD CONSTRAINT "memory_rooms_wing_id_memory_wings_id_fk" FOREIGN KEY ("wing_id") REFERENCES "public"."memory_wings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_rooms" ADD CONSTRAINT "memory_rooms_closet_for_room_id_memory_rooms_id_fk" FOREIGN KEY ("closet_for_room_id") REFERENCES "public"."memory_rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_wings" ADD CONSTRAINT "memory_wings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_wing_id_memory_wings_id_fk" FOREIGN KEY ("wing_id") REFERENCES "public"."memory_wings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_room_id_memory_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."memory_rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_closet_for_room_id_memory_rooms_id_fk" FOREIGN KEY ("closet_for_room_id") REFERENCES "public"."memory_rooms"("id") ON DELETE set null ON UPDATE no action;