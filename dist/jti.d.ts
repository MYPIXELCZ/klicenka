import type { JtiStore } from "./verify.js";
/**
 * In-memory store — only for tests and local development. On serverless every
 * instance has its own memory, so a token could be replayed against another one:
 * production must use a shared store (database table).
 */
export declare class MemoryJtiStore implements JtiStore {
    private used;
    consume(jti: string, expiresAt: Date): Promise<boolean>;
}
/** The store itself failed (table missing, no grant, database down) — not a replay. */
export declare class JtiStoreError extends Error {
    cause: unknown;
    constructor(cause: unknown);
}
/** Unique-key violations across Prisma, Postgres/Supabase and Drizzle. */
export declare function isDuplicateKeyError(e: unknown): boolean;
/**
 * A store on top of any database: `insert` must fail when the id already exists —
 * a unique/primary key does exactly that. A duplicate means the token was used;
 * any other failure throws JtiStoreError, so a missing table reads as a setup
 * problem rather than "already used". `cleanup` (optional) deletes expired rows now
 * and then.
 *
 *   createJtiStore({
 *     insert: (jti, expiresAt) => prisma.klicenkaJti.create({ data: { jti, expiresAt } }).then(() => true),
 *     cleanup: (now) => prisma.klicenkaJti.deleteMany({ where: { expiresAt: { lt: now } } }),
 *   })
 */
export declare function createJtiStore(db: {
    insert(jti: string, expiresAt: Date): Promise<boolean | unknown>;
    cleanup?(now: Date): Promise<unknown>;
    /** Override when the database reports duplicates differently. */
    isDuplicate?(error: unknown): boolean;
}): JtiStore;
