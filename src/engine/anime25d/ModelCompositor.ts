type Locations = { position: number; uv: number; alpha: WebGLUniformLocation; cut: WebGLUniformLocation }

/** Blend already composited models, so their skin and eye stencils never mix. */
export class ModelCompositor {
  private framebuffer: WebGLFramebuffer | null = null
  private stencil: WebGLRenderbuffer | null = null
  private texture: WebGLTexture | null = null
  private positions: WebGLBuffer | null = null
  private uvs: WebGLBuffer | null = null
  private indices: WebGLBuffer | null = null
  private width = 0
  private height = 0

  constructor(private readonly gl: WebGLRenderingContext) {}
  get textureCount() { return this.texture ? 1 : 0 }
  get bufferCount() { return Number(Boolean(this.positions)) + Number(Boolean(this.uvs)) + Number(Boolean(this.indices)) }
  get framebufferCount() { return Number(Boolean(this.framebuffer)) }
  get renderbufferCount() { return Number(Boolean(this.stencil)) }

  render(width: number, height: number, locations: Locations, groups: Array<{ weight: number; draw: () => void }>) {
    const gl = this.gl
    this.ensureTarget(width, height)
    try {
      for (const group of groups) {
        if (group.weight <= 0) continue
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
        gl.viewport(0, 0, width, height)
        gl.disable(gl.STENCIL_TEST)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.clearColor(0, 0, 0, 0)
        gl.clearStencil(0)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
        group.draw()

        // Both the framebuffer and the destination contain premultiplied RGBA.
        // Add weighted complete images; source-over here would darken the blend.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.disable(gl.STENCIL_TEST)
        gl.blendFunc(gl.ONE, gl.ONE)
        gl.uniform1f(locations.alpha, group.weight)
        gl.uniform1f(locations.cut, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positions)
        gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.uvs)
        gl.vertexAttribPointer(locations.uv, 2, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices)
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.STENCIL_TEST)
    }
  }

  dispose() {
    const gl = this.gl
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer)
    if (this.stencil) gl.deleteRenderbuffer(this.stencil)
    if (this.texture) gl.deleteTexture(this.texture)
    for (const buffer of [this.positions, this.uvs, this.indices]) if (buffer) gl.deleteBuffer(buffer)
    this.framebuffer = null
    this.stencil = null
    this.texture = null
    this.positions = this.uvs = this.indices = null
    this.width = this.height = 0
  }

  private ensureTarget(width: number, height: number) {
    if (this.framebuffer && this.width === width && this.height === height) return
    this.dispose()
    const gl = this.gl
    try {
      this.framebuffer = gl.createFramebuffer()
      this.stencil = gl.createRenderbuffer()
      this.texture = gl.createTexture()
      this.positions = gl.createBuffer()
      this.uvs = gl.createBuffer()
      this.indices = gl.createBuffer()
      if (!this.framebuffer || !this.stencil || !this.texture || !this.positions || !this.uvs || !this.indices) throw new Error("Model transition GPU allocation failed")
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.stencil)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, width, height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.stencil)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Model transition framebuffer is incomplete")
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positions)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, width, 0, 0, height, width, height]), gl.STATIC_DRAW)
      // Framebuffer textures use the opposite vertical origin to source sprites.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvs)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 1, 3, 2]), gl.STATIC_DRAW)
      this.width = width
      this.height = height
    } catch (error) {
      this.dispose()
      throw error
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
  }
}
