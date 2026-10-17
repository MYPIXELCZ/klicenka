/**
 * In-memory store — only for tests and local development. On serverless every
 * instance has its own memory, so a token could be replayed against another one:
 * production must use a shared store (database table).
 */
export class MemoryJtiStore {
    used = new Map();
    async consume(jti, expiresAt) {
        const now = Date.now();
        for (const [k, exp] of this.used)
            if (exp < now)
                this.used.delete(k);
        if (this.used.has(jti))
            return false;
        this.used.set(jti, expiresAt.getTime());
        return true;
    }
}
/** The store itself failed (table missing, no grant, database down) — not a replay. */
export class JtiStoreError extends Error {
    cause;
    constructor(cause) {
        super("Úložiště použitých tokenů nefunguje");
        this.cause = cause;
    }
}
/** Unique-key violations across Prisma, Postgres/Supabase and Drizzle. */
export function isDuplicateKeyError(e) {
    const err = e;
    if (!err)
        return false;
    if (err.code === "P2002" || err.code === "23505")
        return true;
    if (typeof err.message === "string" && /duplicate key|unique constraint|already exists/i.test(err.message))
        return true;
    return err.cause ? isDuplicateKeyError(err.cause) : false;
}
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
export function createJtiStore(db) {
    const duplicate = db.isDuplicate ?? isDuplicateKeyError;
    return {
        async consume(jti, expiresAt) {
            if (db.cleanup && Math.random() < 0.05)
                db.cleanup(new Date()).catch(() => { });
            let r;
            try {
                r = await db.insert(jti, expiresAt);
            }
            catch (e) {
                if (duplicate(e))
                    return false;
                throw new JtiStoreError(e);
            }
            return r !== false;
        },
    };
}
