import { addKeyword } from '@builderbot/bot'

import type { CreateFlowInput, UpdateFlowInput, FlowStep } from './schemas'
import type { Flow } from './types'

/**
 * Snapshot of the entire flow registry state, used for rollback
 */
export interface FlowRegistrySnapshot {
    flows: Map<string, FlowDefinition>
}

/**
 * Flow definition stored in registry
 */
export interface FlowDefinition {
    id: string
    name: string
    flow: Flow
    /** Whether this flow was created dynamically via API */
    dynamic: boolean
    /** Original configuration for dynamic flows */
    config?: CreateFlowInput
    /** Timestamp when flow was registered */
    createdAt: Date
    /** Timestamp when flow was last updated */
    updatedAt: Date
}

/**
 * FlowRegistry manages flow definitions that can be used when creating bots
 */
export class FlowRegistry {
    private flows: Map<string, FlowDefinition> = new Map()

    /**
     * Register a programmatic flow (created with addKeyword).
     * If a flow with the same id already exists, it will NOT be overwritten
     * unless `force` is true — this prevents duplicate registration.
     */
    register(id: string, name: string, flow: Flow, force = false): FlowDefinition {
        if (this.flows.has(id) && !force) {
            return this.flows.get(id)!
        }

        const definition: FlowDefinition = {
            id,
            name,
            flow,
            dynamic: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        }
        this.flows.set(id, definition)
        return definition
    }

    /**
     * Register a dynamic flow from JSON configuration.
     * Throws if a flow with the same id already exists to prevent duplicate registration.
     */
    registerDynamic(config: CreateFlowInput, allowOverwrite = false): FlowDefinition {
        const { id, name, keyword, steps } = config

        if (this.flows.has(id) && !allowOverwrite) {
            throw new Error(`Flow with id "${id}" already exists`)
        }

        const flow = this.buildFlowFromSteps(keyword, steps)

        const existing = this.flows.get(id)

        const definition: FlowDefinition = {
            id,
            name,
            flow,
            dynamic: true,
            config,
            createdAt: existing?.createdAt ?? new Date(),
            updatedAt: new Date(),
        }

        this.flows.set(id, definition)
        return definition
    }

    /**
     * Update a dynamic flow.
     * Returns the previous definition on success (useful for rollback), or null if not found.
     */
    update(id: string, updates: UpdateFlowInput): { definition: FlowDefinition; previous: FlowDefinition } | null {
        const existing = this.flows.get(id)
        if (!existing || !existing.dynamic || !existing.config) {
            return null
        }

        // Deep clone existing config for previous snapshot
        const previousConfig: CreateFlowInput = JSON.parse(JSON.stringify(existing.config))
        const previous: FlowDefinition = {
            ...existing,
            config: previousConfig,
            createdAt: new Date(existing.createdAt.getTime()),
            updatedAt: new Date(existing.updatedAt.getTime()),
        }

        // Merge updates with existing config
        const newConfig: CreateFlowInput = {
            ...existing.config,
            ...(updates.name !== undefined && { name: updates.name }),
            ...(updates.keyword !== undefined && { keyword: updates.keyword }),
            ...(updates.steps !== undefined && { steps: updates.steps }),
        }

        // Rebuild flow
        const flow = this.buildFlowFromSteps(newConfig.keyword, newConfig.steps)

        const definition: FlowDefinition = {
            id,
            name: newConfig.name,
            flow,
            dynamic: true,
            config: newConfig,
            createdAt: existing.createdAt,
            updatedAt: new Date(),
        }

        this.flows.set(id, definition)
        return { definition, previous }
    }

    /**
     * Remove a flow from registry.
     * Returns the removed definition (useful for rollback), or false if not found.
     */
    remove(id: string): FlowDefinition | false {
        const existing = this.flows.get(id)
        if (!existing) return false
        this.flows.delete(id)
        return existing
    }

    /**
     * Restore a previously removed flow definition (for rollback)
     */
    restore(definition: FlowDefinition): void {
        this.flows.set(definition.id, definition)
    }

    /**
     * Take a snapshot of the entire registry state for later rollback
     */
    snapshot(): FlowRegistrySnapshot {
        const cloned = new Map<string, FlowDefinition>()
        for (const [key, def] of this.flows.entries()) {
            cloned.set(key, {
                ...def,
                config: def.config ? JSON.parse(JSON.stringify(def.config)) : undefined,
                createdAt: new Date(def.createdAt.getTime()),
                updatedAt: new Date(def.updatedAt.getTime()),
            })
        }
        return { flows: cloned }
    }

    /**
     * Restore the registry to a previous snapshot state (full rollback)
     */
    rollback(snapshot: FlowRegistrySnapshot): void {
        this.flows = new Map<string, FlowDefinition>()
        for (const [key, def] of snapshot.flows.entries()) {
            this.flows.set(key, {
                ...def,
                config: def.config ? JSON.parse(JSON.stringify(def.config)) : undefined,
                createdAt: new Date(def.createdAt.getTime()),
                updatedAt: new Date(def.updatedAt.getTime()),
            })
        }
    }

    /**
     * Get a flow by ID
     */
    get(id: string): FlowDefinition | undefined {
        return this.flows.get(id)
    }

    /**
     * Get all registered flows
     */
    getAll(): FlowDefinition[] {
        return Array.from(this.flows.values())
    }

    /**
     * Check if a flow exists
     */
    has(id: string): boolean {
        return this.flows.has(id)
    }

    /**
     * Get all flow IDs
     */
    getIds(): string[] {
        return Array.from(this.flows.keys())
    }

    /**
     * Get count of registered flows
     */
    count(): number {
        return this.flows.size
    }

    /**
     * Clear all flows
     */
    clear(): void {
        this.flows.clear()
    }

    /**
     * Get flows by type (dynamic or programmatic)
     */
    getByType(dynamic: boolean): FlowDefinition[] {
        return this.getAll().filter((f) => f.dynamic === dynamic)
    }

    /**
     * Resolve multiple flow IDs to Flow objects
     */
    resolveFlows(flowIds: string[]): { flows: Flow[]; missing: string[] } {
        const flows: Flow[] = []
        const missing: string[] = []

        for (const id of flowIds) {
            const definition = this.flows.get(id)
            if (definition) {
                flows.push(definition.flow)
            } else {
                missing.push(id)
            }
        }

        return { flows, missing }
    }

    /**
     * Build a flow from steps configuration
     */
    private buildFlowFromSteps(keyword: string | string[], steps: FlowStep[]): Flow {
        const keywords: string | [string, ...string[]] = Array.isArray(keyword)
            ? (keyword as [string, ...string[]])
            : keyword

        let flow = addKeyword(keywords)

        for (const step of steps) {
            const options: any = {}

            if (step.delay) options.delay = step.delay
            if (step.media) options.media = step.media
            if (step.capture) options.capture = step.capture

            flow = flow.addAnswer(step.answer, Object.keys(options).length > 0 ? options : undefined)
        }

        return flow
    }

    /**
     * Export all dynamic flows as serializable configs
     */
    exportDynamicFlows(): CreateFlowInput[] {
        return this.getByType(true)
            .filter((f) => f.config)
            .map((f) => f.config!)
    }

    /**
     * Import dynamic flows from configs
     */
    importDynamicFlows(configs: CreateFlowInput[]): { imported: number; failed: string[] } {
        const failed: string[] = []
        let imported = 0

        for (const config of configs) {
            try {
                if (!this.has(config.id)) {
                    this.registerDynamic(config)
                    imported++
                }
            } catch {
                failed.push(config.id)
            }
        }

        return { imported, failed }
    }
}
