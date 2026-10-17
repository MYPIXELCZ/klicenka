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
export function createJtiStore(db) {
    return {
        async consume(jti, expiresAt) {
            if (db.cleanup && Math.random() < 0.05)
                db.cleanup(new Date()).catch(() => { });
            try {
                const r = await db.insert(jti, expiresAt);
                return r !== false;
            }
            catch {
                return false;
            }
        },
    };
}
