import type { Anime25DParameter } from "../../engine/anime25d/types"
import { ParameterMixer } from "../../interaction/ParameterMixer"
import type {
  MotionContribution,
  MotionContributionFrame,
  MotionSourceDiagnostics,
  MotionSourceHostApi,
  MotionSourceLease,
  MotionSourceStatus,
  MotionSourceUpdateOptions,
} from "./types"

type LeaseRecord = MotionSourceDiagnostics

const clampWeight = (value: number) => Math.max(0, Math.min(1, value))
const defaultNow = () => typeof performance === "undefined" ? Date.now() : performance.now()

export class MotionSourceHost implements MotionSourceHostApi {
  private readonly activeSlots = new Map<string, LeaseRecord>()
  private readonly records: LeaseRecord[] = []
  private nextToken = 1

  constructor(
    private readonly mixer: ParameterMixer,
    private readonly now: () => number = defaultNow,
    private readonly historyLimit = 128,
  ) {}

  acquire(options: { slot: string; ownerId: string; priority: number; weight?: number }): MotionSourceLease {
    const previous = this.activeSlots.get(options.slot)
    if (previous) {
      previous.status = "superseded"
      previous.updatedAt = this.now()
      this.mixer.removeSource(options.slot)
    }

    const createdAt = this.now()
    const record: LeaseRecord = {
      slot: options.slot,
      ownerId: options.ownerId,
      token: this.nextToken++,
      priority: options.priority,
      weight: clampWeight(options.weight ?? 1),
      activeParameterCount: 0,
      modeOverrides: {},
      status: "active",
      createdAt,
      updatedAt: createdAt,
    }
    this.activeSlots.set(record.slot, record)
    this.records.push(record)
    this.trimHistory()

    return {
      slot: record.slot,
      ownerId: record.ownerId,
      token: record.token,
      update: (values, updateOptions) => this.update(record, values, updateOptions),
      release: () => this.release(record, "released"),
      active: () => this.isActive(record),
    }
  }

  releaseOwner(ownerId: string): void {
    for (const record of [...this.activeSlots.values()]) {
      if (record.ownerId === ownerId) this.release(record, "released")
    }
  }

  clear(): void {
    const at = this.now()
    for (const record of this.activeSlots.values()) {
      record.status = "cleared"
      record.updatedAt = at
    }
    this.activeSlots.clear()
    this.mixer.clear()
  }

  diagnostics(): MotionSourceDiagnostics[] {
    return this.records.map((record) => ({ ...record, modeOverrides: { ...record.modeOverrides } }))
  }

  private update(record: LeaseRecord, values: MotionContributionFrame, options: MotionSourceUpdateOptions = {}): void {
    if (!this.isActive(record)) return
    record.priority = options.priority ?? record.priority
    record.weight = clampWeight(options.weight ?? record.weight)
    record.activeParameterCount = Object.keys(values).length
    record.modeOverrides = this.collectModes(values, options.modes)
    record.updatedAt = this.now()
    this.mixer.setSource(record.slot, this.applyModes(values, options.modes), record.priority, record.weight)
  }

  private release(record: LeaseRecord, status: MotionSourceStatus): void {
    if (!this.isActive(record)) return
    record.status = status
    record.updatedAt = this.now()
    this.activeSlots.delete(record.slot)
    this.mixer.removeSource(record.slot)
  }

  private isActive(record: LeaseRecord): boolean {
    return record.status === "active" && this.activeSlots.get(record.slot)?.token === record.token
  }

  private applyModes(values: MotionContributionFrame, modes?: MotionSourceUpdateOptions["modes"]): MotionContributionFrame {
    if (!modes || !Object.keys(modes).length) return values
    const result: MotionContributionFrame = { ...values }
    for (const [key, mode] of Object.entries(modes) as Array<[Anime25DParameter, NonNullable<typeof modes>[Anime25DParameter]]>) {
      const contribution = result[key]
      if (contribution === undefined || mode === undefined) continue
      result[key] = typeof contribution === "number" ? { value: contribution, mode } : { ...contribution, mode }
    }
    return result
  }

  private collectModes(values: MotionContributionFrame, modes?: MotionSourceUpdateOptions["modes"]): MotionSourceDiagnostics["modeOverrides"] {
    const result: MotionSourceDiagnostics["modeOverrides"] = { ...modes }
    for (const [key, contribution] of Object.entries(values) as Array<[Anime25DParameter, MotionContribution]>) {
      if (typeof contribution !== "number" && contribution.mode) result[key] = contribution.mode
    }
    return result
  }

  private trimHistory(): void {
    while (this.records.length > this.historyLimit) {
      const removable = this.records.findIndex((record) => record.status !== "active")
      if (removable < 0) break
      this.records.splice(removable, 1)
    }
  }
}
