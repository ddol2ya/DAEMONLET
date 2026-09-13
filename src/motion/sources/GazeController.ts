const smooth = (value: number, target: number, speed: number, dt: number) => value + (target - value) * (1 - Math.exp(-speed * dt))

export type PointerGazeOutput = { eyeX: number; eyeY: number; headX: number; headY: number }

export class GazeController {
  private output: PointerGazeOutput = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 }

  update(targetEyeX: number, targetEyeY: number, dt: number): PointerGazeOutput {
    this.output.eyeX = smooth(this.output.eyeX, targetEyeX, 15, dt)
    this.output.eyeY = smooth(this.output.eyeY, targetEyeY, 15, dt)
    this.output.headX = smooth(this.output.headX, targetEyeX * 0.55, 4.2, dt)
    this.output.headY = smooth(this.output.headY, -targetEyeY * 0.4, 4.2, dt)
    return { ...this.output }
  }

  reset(output: PointerGazeOutput = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 }): void {
    this.output = { ...output }
  }

  getDiagnostics(): PointerGazeOutput {
    return { ...this.output }
  }
}
