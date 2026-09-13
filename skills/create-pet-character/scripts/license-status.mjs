// Technical readiness and rights review are independent; acknowledgements are not grants.
export function externalLicenseStatus(dependencies) {
  const entries = [
    {id: 'ComfyUI', review: dependencies.comfyui?.licenseEvidence},
    {id: 'ComfyUI-See-through', review: dependencies.seeThrough?.licenseEvidence},
    ...(dependencies.models ?? []).map(model => ({id: model.id, review: model.licenseEvidence})),
  ].map(({id, review}) => ({id, status: review?.status ?? 'unverified', license: review?.license ?? null,
    revision: review?.revision ?? null, verifiedOn: review?.verifiedOn ?? null,
    installedRevisionChecked: false}))
  return {status: entries.some(e => e.status !== 'verified') ? 'pending' : 'recorded-upstream-only',
    installedEnvironment: 'unverified', entries, acknowledgementGrantsRights: false}
}
