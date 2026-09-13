export const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uRes;
varying vec2 vUV;
void main() {
  vUV = aUV;
  vec2 clip = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`

export const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uCut;
uniform float uAlpha;
void main() {
  vec4 color = texture2D(uTex, vUV);
  if (color.a < uCut) discard;
  gl_FragColor = color * uAlpha;
}`
