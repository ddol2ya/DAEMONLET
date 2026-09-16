import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { registerActivationHandler } from "../electron/main/AppActivation"

describe("macOS app activation", () => {
  it("uses the same resident recovery entry when available", () => {
    const app = new EventEmitter(), controller = { showPet: vi.fn(), activate: vi.fn() }
    const unregister = registerActivationHandler(app as never, () => controller)
    app.emit("activate"); expect(controller.activate).toHaveBeenCalledOnce(); expect(controller.showPet).not.toHaveBeenCalled()
    unregister(); app.emit("activate"); expect(controller.activate).toHaveBeenCalledOnce()
  })
  it("shows the Pet through the controller when the app activates", () => {
    const app = new EventEmitter()
    const controller = { showPet: vi.fn() }
    const unregister = registerActivationHandler(app as never, () => controller)

    app.emit("activate")

    expect(controller.showPet).toHaveBeenCalledOnce()
    unregister()
  })

  it("is a no-op while the controller is not ready", () => {
    const app = new EventEmitter()
    const unregister = registerActivationHandler(app as never, () => null)

    expect(() => app.emit("activate")).not.toThrow()
    unregister()
  })

  it("does not show the Pet after before-quit clears the controller", () => {
    const app = new EventEmitter()
    const target = { showPet: vi.fn() }
    let controller: typeof target | null = target
    const unregister = registerActivationHandler(app as never, () => controller)

    controller = null
    app.emit("activate")

    expect(target.showPet).not.toHaveBeenCalled()
    unregister()
  })
})
