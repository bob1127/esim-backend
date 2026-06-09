import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260518034617 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "push_subscription" ("id" text not null, "customer_id" text null, "endpoint" text not null, "auth" text not null, "p256dh" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "push_subscription_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_push_subscription_deleted_at" ON "push_subscription" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "push_subscription" cascade;`);
  }

}
