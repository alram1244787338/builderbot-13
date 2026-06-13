type Logger = Console

interface QueueItem<T> {
    promiseFunc: (item: QueueItem<T>) => PromiseFunctionWrapper<T>
    fingerIdRef: string
    cancelled: boolean
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: any) => void
}

interface PromiseFunctionWrapper<T> {
    promiseInFunc: () => Promise<T>
    timer: (item: { resolve: (value: T | PromiseLike<T>) => void }) => NodeJS.Timeout
    timerPromise: Promise<T>
    cancel: () => void
}

class Queue<T> {
    private queue: Map<string, QueueItem<T>[]>
    private timers: Map<string, NodeJS.Timeout | boolean>
    private idsCallbacks: Map<string, string[]>
    private workingOnPromise: Map<string, boolean>
    private logger: Logger
    private timeout: number
    private concurrencyLimit: number

    constructor(logger: Logger, concurrencyLimit = 15, timeout = 50000) {
        this.queue = new Map()
        this.timers = new Map()
        this.idsCallbacks = new Map()
        this.workingOnPromise = new Map()
        this.logger = logger
        this.timeout = timeout
        this.concurrencyLimit = concurrencyLimit < 1 ? 15 : concurrencyLimit
    }

    /**
     * Limpiar cola de proceso
     * @param from
     * @param item
     */
    public clearAndDone(from: string, item: { fingerIdRef: string }) {
        this.clearIdFromCallback(from, item.fingerIdRef)
        this.clearTimer(item.fingerIdRef)
        this.logger.log(`${from}: SUCCESS: ${item.fingerIdRef}`)
    }

    /**
     * Clear a single timer by fingerIdRef (scoped to one item, not global).
     */
    private clearTimer(fingerIdRef: string): void {
        const t = this.timers.get(fingerIdRef)
        if (t && typeof t !== 'boolean') {
            clearTimeout(t as NodeJS.Timeout)
        }
        this.timers.delete(fingerIdRef)
    }

    private async processItem(from: string, item: QueueItem<T>): Promise<void> {
        try {
            const refToPromise = item.promiseFunc(item)
            const value = await Promise.race([
                refToPromise.timerPromise,
                refToPromise.promiseInFunc().then(() => {
                    refToPromise.cancel()
                    return 'success' as unknown as T
                }),
            ])
            item.resolve(value)
        } catch (err) {
            // Only clean the timer; clearAndDone in finally handles the rest
            this.clearTimer(item.fingerIdRef)
            this.logger.error(`${from}:ERROR: ${JSON.stringify(err)}`)
            item.reject(err)
        }
    }

    async enqueue(from: string, promiseInFunc: () => Promise<T>, fingerIdRef: string): Promise<T> {
        this.logger.log(`${from}: QUEUE: ${fingerIdRef}`)

        if (!this.timers.has(fingerIdRef)) {
            this.timers.set(fingerIdRef, false)
        }

        if (!this.queue.has(from)) {
            this.queue.set(from, [])
            this.workingOnPromise.set(from, false)
        }

        const queueByFrom = this.queue.get(from)!

        /**
         *
         * @param item
         * @returns
         */
        const promiseFunc = (item: QueueItem<T>): PromiseFunctionWrapper<T> => {
            type ITimerPromise = {
                resolve: (value: T | PromiseLike<T>) => void
                reject: (value: T | PromiseLike<T>) => void
            }

            // Modo seguro por defecto: no limpia la cola al crear el timeout y gestiona timers por item
            const timer = ({ reject }: ITimerPromise) =>
                setTimeout(() => {
                    reject(new Error(`Queue item timeout after ${this.timeout}ms`) as unknown as T)
                }, this.timeout)

            const timerPromise = new Promise<T>((resolve, reject) => {
                if (item.cancelled) return reject('cancelled' as unknown as any)
                const existing = this.timers.get(fingerIdRef)
                if (existing && typeof existing !== 'boolean') clearTimeout(existing as NodeJS.Timeout)
                const refIdTimeOut = timer({ reject, resolve })
                this.timers.set(fingerIdRef, refIdTimeOut)
            })

            const cancel = () => {
                this.clearTimer(fingerIdRef)
                this.clearAndDone(from, item)
            }
            return { promiseInFunc, timer, timerPromise, cancel }
        }

        return new Promise<T>((resolve, reject) => {
            const pid = queueByFrom.findIndex((i) => i.fingerIdRef === fingerIdRef)
            if (pid !== -1) {
                // Ignorar silenciosamente duplicados del mismo ID y resolver en éxito
                this.logger.log(`${from}: DUPLICATE: ${fingerIdRef} (ignored)`)
                return resolve('success' as unknown as T)
            }

            queueByFrom.push({
                promiseFunc,
                fingerIdRef,
                cancelled: false,
                resolve,
                reject,
            })

            if (!this.workingOnPromise.get(from)) {
                this.logger.log(`${from}: EXECUTING: ${fingerIdRef}`)
                this.workingOnPromise.set(from, true)
                this.processQueue(from)
            }
        })
    }

    async processQueue(from: string): Promise<void> {
        const queueByFrom = this.queue.get(from)
        if (!queueByFrom) {
            this.workingOnPromise.set(from, false)
            return
        }

        while (queueByFrom.length > 0) {
            // Procesar UN solo item a la vez por usuario para mantener el orden
            const item = queueByFrom.shift()!
            if (item.cancelled) continue

            try {
                await this.processItem(from, item)
            } catch (_err) {
                // El error ya fue gestionado en processItem (item.reject llamado).
                // Continuamos con el siguiente item en la cola.
            } finally {
                this.clearAndDone(from, item)
            }
        }

        this.workingOnPromise.set(from, false)
    }

    async clearQueue(from: string): Promise<number> {
        if (this.queue.has(from)) {
            const queueByFrom = this.queue.get(from)!

            try {
                for (const item of queueByFrom) {
                    item.cancelled = true
                    this.clearAndDone(from, item)
                    // Resolver silenciosamente las tareas pendientes al limpiar la cola
                    item.resolve('success' as unknown as T)
                }
            } finally {
                this.queue.set(from, [])
                this.idsCallbacks.set(from, [])
                // Solo limpiar timers que pertenecen a este usuario, no globalmente
                // Los timers de items en cola se limpian vía clearAndDone -> clearTimer
            }

            this.workingOnPromise.set(from, false)
            return 0
        }
        return 0
    }

    setIdsCallbacks(from: string, ids: string[] = []): void {
        this.idsCallbacks.set(from, ids)
    }

    getIdsCallback(from: string): string[] {
        return this.idsCallbacks.get(from) || []
    }

    getIdWithFrom(from: string, id: string): number {
        const ids = this.idsCallbacks.get(from) || []
        const index = ids.indexOf(id)
        return index
    }

    clearIdFromCallback(from: string, id: string): void {
        if (this.idsCallbacks.has(from)) {
            const ids = this.idsCallbacks.get(from)!
            const index = ids.indexOf(id)

            if (index !== -1) {
                ids.splice(index, 1)
            }
        }
    }
}

export { Queue }
