import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema"

// Neon requires SSL. Make the mode explicit to silence the pg v9 deprecation
// warning about implicit 'require' being treated as 'verify-full'.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
export const db = drizzle(pool, { schema })
