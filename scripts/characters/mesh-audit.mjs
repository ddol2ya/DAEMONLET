// Run against renderer meshes; orientation is relative to each source triangle.
export function auditEyeMeshes(layers) {
  const area=(a,i,j,k)=>(a[j*2]-a[i*2])*(a[k*2+1]-a[i*2+1])-(a[j*2+1]-a[i*2+1])*(a[k*2]-a[i*2])
  let folds=0,triangles=0,minRatio=Infinity
  for(const l of layers.filter(l=>l.fade==='eyeOpen'))for(let y=0;y<l.ny;y++)for(let x=0;x<l.nx;x++){
    const a=y*(l.nx+1)+x,b=a+1,c=a+l.nx+1,d=c+1
    for(const ids of [[a,b,c],[b,d,c]]){
      const before=area(l.base,...ids),after=area(l.current,...ids)
      if(!Number.isFinite(before)||!Number.isFinite(after))throw Error('Nonfinite eye mesh')
      if(Math.abs(before)<1e-5)continue
      const ratio=after/before;triangles++;minRatio=Math.min(minRatio,ratio);if(ratio<-.0001)folds++
    }
  }
  return {folds,triangles,minRatio:triangles?minRatio:null}
}
