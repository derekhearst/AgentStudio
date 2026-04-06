import postgres from "postgres";

const sql = postgres({
  host: "192.168.0.2",
  port: 5432,
  user: "derek",
  password: "d8ACeA2x9oW#oP",
  database: "postgres",
});

try {
  await sql`CREATE DATABASE "AGENTSTUDIO" TEMPLATE template0`;
  console.log("Database AGENTSTUDIO created successfully.");
} catch (e: any) {
  console.error("Error:", e.message);
} finally {
  await sql.end();
}
