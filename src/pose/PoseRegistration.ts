import type { Point, RigAnchors } from "../engine/anime25d/types"
import type { PoseManifest, PoseRegistrationDiagnostics, PoseTransform } from "./types"

const distance = (a: Point, b: Point) => Math.hypot(b.cx - a.cx, b.cy - a.cy)
const midpoint = (a: Point, b: Point): Point => ({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 })
const radiansToDegrees = (value: number) => value * 180 / Math.PI

export function transformPosePoint(point: Point, transform: PoseTransform): Point {
  const x = point.cx - transform.sourceCenterX
  const y = point.cy - transform.sourceCenterY
  const cos = Math.cos(transform.rotationRad)
  const sin = Math.sin(transform.rotationRad)
  return {
    cx: transform.sourceCenterX + (x * cos - y * sin) * transform.scale + transform.translationX,
    cy: transform.sourceCenterY + (x * sin + y * cos) * transform.scale + transform.translationY,
  }
}

export function registerPose(
  base: RigAnchors,
  pose: RigAnchors,
  limits: PoseManifest["registration"],
  canvas?: { base: { w: number; h: number }; pose: { w: number; h: number } },
): PoseRegistrationDiagnostics {
  if (!base.eyeL || !base.eyeR || !pose.eyeL || !pose.eyeR) throw new Error("POSE_ASSET_REGISTRATION_FAILED: both rigs require left and right eye anchors")
  const baseLeft = { cx: base.eyeL.icx, cy: base.eyeL.icy }
  const baseRight = { cx: base.eyeR.icx, cy: base.eyeR.icy }
  const poseLeft = { cx: pose.eyeL.icx, cy: pose.eyeL.icy }
  const poseRight = { cx: pose.eyeR.icx, cy: pose.eyeR.icy }
  const baseCenter = midpoint(baseLeft, baseRight)
  const poseCenter = midpoint(poseLeft, poseRight)
  const baseEyeDistance = distance(baseLeft, baseRight)
  const poseEyeDistance = distance(poseLeft, poseRight)
  if (baseEyeDistance < 1 || poseEyeDistance < 1) throw new Error("POSE_ASSET_REGISTRATION_FAILED: eye distance is too small")
  const scale = baseEyeDistance / poseEyeDistance
  const baseAngle = Math.atan2(baseRight.cy - baseLeft.cy, baseRight.cx - baseLeft.cx)
  const poseAngle = Math.atan2(poseRight.cy - poseLeft.cy, poseRight.cx - poseLeft.cx)
  const rotationRad = baseAngle - poseAngle
  const provisional: PoseTransform = {
    scale,
    rotationRad,
    translationX: 0,
    translationY: 0,
    sourceCenterX: poseCenter.cx,
    sourceCenterY: poseCenter.cy,
  }
  const mappedCenter = transformPosePoint(poseCenter, provisional)
  const transform = {
    ...provisional,
    translationX: baseCenter.cx - mappedCenter.cx,
    translationY: baseCenter.cy - mappedCenter.cy,
  }
  const mappedLeft = transformPosePoint(poseLeft, transform)
  const mappedRight = transformPosePoint(poseRight, transform)
  const mappedNeck = transformPosePoint(pose.neckPivot, transform)
  const eyeResidualError = (distance(mappedLeft, baseLeft) + distance(mappedRight, baseRight)) / 2
  const neckResidualError = distance(mappedNeck, base.neckPivot)
  const canvasScaleX = canvas ? canvas.base.w / canvas.pose.w : 1
  const canvasScaleY = canvas ? canvas.base.h / canvas.pose.h : 1
  const expectedCanvasScale = Math.sqrt(canvasScaleX * canvasScaleY)
  const scaleDelta = Math.abs(scale / expectedCanvasScale - 1)
  const rotationDeg = radiansToDegrees(rotationRad)
  const reasons: string[] = []
  if (scaleDelta > limits.maxScaleDelta) reasons.push(`scale delta ${scaleDelta.toFixed(4)} exceeds ${limits.maxScaleDelta}`)
  if (Math.abs(rotationDeg) > limits.maxRotationDeg) reasons.push(`rotation ${rotationDeg.toFixed(3)}deg exceeds ${limits.maxRotationDeg}deg`)
  if (eyeResidualError > limits.maxAnchorErrorPx) reasons.push(`eye residual ${eyeResidualError.toFixed(2)}px exceeds ${limits.maxAnchorErrorPx}px`)
  if (neckResidualError > limits.maxAnchorErrorPx) reasons.push(`neck residual ${neckResidualError.toFixed(2)}px exceeds ${limits.maxAnchorErrorPx}px`)
  return {
    accepted: reasons.length === 0,
    errorCode: reasons.length ? "POSE_ASSET_REGISTRATION_FAILED" : null,
    baseEyeDistance,
    poseEyeDistance,
    scale,
    scaleDelta,
    rotationDeg,
    eyeResidualError,
    neckResidualError,
    reasons,
    transform,
  }
}
