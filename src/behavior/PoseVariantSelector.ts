import type { RandomSource } from "./IdleActionScheduler"

type Bag = { signature: string; remaining: string[]; last: string | null }

/** Visit each available model once per shuffled cycle, including cycle boundaries. */
export class PoseVariantSelector {
  private readonly bags = new Map<string, Bag>()

  constructor(private readonly random: RandomSource = Math.random) {}

  choose(owner: string, poses: readonly string[]): string | null {
    if (poses.length < 2) return poses[0] ?? null
    const signature = poses.join("\0")
    let bag = this.bags.get(owner)
    if (!bag || bag.signature !== signature) {
      bag = { signature, remaining: [], last: bag?.last ?? null }
      this.bags.set(owner, bag)
    }
    if (!bag.remaining.length) {
      bag.remaining = [...poses]
      for (let i = bag.remaining.length - 1; i > 0; i--) {
        const value = this.random()
        const j = Math.floor((Number.isFinite(value) ? Math.max(0, Math.min(.999999, value)) : 0) * (i + 1))
        ;[bag.remaining[i], bag.remaining[j]] = [bag.remaining[j], bag.remaining[i]]
      }
      if (bag.remaining[0] === bag.last) {
        ;[bag.remaining[0], bag.remaining[1]] = [bag.remaining[1], bag.remaining[0]]
      }
    }
    bag.last = bag.remaining.shift()!
    return bag.last
  }

  clear(): void { this.bags.clear() }
}
