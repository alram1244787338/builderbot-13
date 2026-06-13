/**
 * Simple async mutex for serializing operations on shared resources.
 * Prevents concurrent mutations to the same resource key (e.g. a flow ID or tenant ID).
 */
export class Mutex {
    private locks: Map<string, Promise<void>> = new Map()

    /**
     * Acquire a lock for the given key.
     * Returns a release function that MUST be called when the critical section is done.
     */
    async acquire(key: string): Promise<() => void> {
        // Wait for any existing lock on this key
        while (this.locks.has(key)) {
            await this.locks.get(key)
        }

        let release!: () => void
        const lockPromise = new Promise<void>((resolve) => {
            release = resolve
        })

        this.locks.set(key, lockPromise)

        let released = false
        return () => {
            if (released) return
            released = true
            this.locks.delete(key)
            release()
        }
    }

    /**
     * Execute a function under a lock for the given key.
     * Automatically releases the lock when done (even on error).
     */
    async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const release = await this.acquire(key)
        try {
            return await fn()
        } finally {
            release()
        }
    }

    /**
     * Execute a function under locks for multiple keys simultaneously.
     * Keys are sorted to prevent deadlocks.
     */
    async runExclusiveMulti<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
        const sortedKeys = [...new Set(keys)].sort()
        const releases: Array<() => void> = []

        try {
            for (const key of sortedKeys) {
                releases.push(await this.acquire(key))
            }
            return await fn()
        } finally {
            // Release in reverse order
            for (let i = releases.length - 1; i >= 0; i--) {
                releases[i]()
            }
        }
    }

    /**
     * Check if a key is currently locked
     */
    isLocked(key: string): boolean {
        return this.locks.has(key)
    }

    /**
     * Get the number of active locks
     */
    get activeLocks(): number {
        return this.locks.size
    }
}
