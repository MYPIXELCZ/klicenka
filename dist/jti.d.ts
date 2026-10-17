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
/**
 * A store on top of any database: `insert` must fail (throw or return false) when
 * the id already exists — a unique/primary key does exactly that. `cleanup` (optional)
 * deletes rows that expired; it runs now and then.
 *
 *   createJtiStore({
 *     insert: (jti, expiresAt) => prisma.klicenkaJti.create({ data: { jti, expiresAt } }).then(() => true),
 *     cleanup: (now) => prisma.klicenkaJti.deleteMany({ where: { expiresAt: { lt: now } } }),
 *   })
 */
export declare function createJtiStore(db: {
    insert(jti: string, expiresAt: Date): Promise<boolean | unknown>;
    cleanup?(now: Date): Promise<unknown>;
}): JtiStore;
