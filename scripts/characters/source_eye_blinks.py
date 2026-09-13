"""Measure each source eye separately and preserve registered eyelid placement."""
import math
import numpy as np
def rebuild_lid(panel,a,side):
 outer,inner=16,5
 x0=max(0,int(a['x0']-(outer if side=='l' else inner)));x1=min(1280,int(a['x1']+(inner if side=='l' else outer)+1))
 y0=max(0,int(a['y0']-8));y1=min(1280,int(a['y1']+18))
 rgb=panel[y0:y1,x0:x1,:3].astype(float);h,w=rgb.shape[:2];yy,xx=np.indices((h,w))
 dark=np.clip((183-rgb[:,:,1])/80,0,1)*np.clip((rgb[:,:,0]-rgb[:,:,1]-18)/30,0,1)
 expected=(a['y0']+a['y1'])/2+3-y0
 scores=dark*3-.002*(yy-expected)**2
 cost=np.full((h,w),-1e9);back=np.zeros((h,w),int);cost[:,0]=scores[:,0]
 for x in range(1,w):
  for y in range(h):
   candidates=np.arange(max(0,y-2),min(h,y+3));v=cost[candidates,x-1]-.18*(candidates-y)**2
   at=np.argmax(v);cost[y,x]=scores[y,x]+v[at];back[y,x]=candidates[at]
 ridge=np.zeros(w,int);ridge[-1]=np.argmax(cost[:,-1])
 for x in range(w-1,0,-1):ridge[x-1]=back[ridge[x],x]
 band=np.clip(6.5-np.abs(yy-ridge[None,:]),0,1)
 alpha=np.clip((dark-.04)/.70,0,1)*band
 alpha[:,:2]*=np.array([.2,.7])[None,:];alpha[:,-2:]*=np.array([.7,.2])[None,:]
 # Remove skin contamination from partially covered edge pixels.
 bg=np.quantile(rgb,.78,axis=0);aa=np.maximum(alpha[:,:,None],.05)
 fg=np.clip((rgb-(1-alpha[:,:,None])*bg[None,:,:])/aa,0,255)
 fg[alpha>.97]=rgb[alpha>.97]
 out=np.zeros((1280,1280,4),np.uint8);out[y0:y1,x0:x1,:3]=np.uint8(np.rint(fg));out[y0:y1,x0:x1,3]=np.uint8(np.rint(alpha*255));out[out[:,:,3]==0,:3]=0
 return out,{'window':[x0,y0,x1,y1],'ridge':[[x+x0,int(y+y0)] for x,y in enumerate(ridge)]}

def make_profile(white,lid):
 ys,xs=np.where(white[:,:,3]>128);q0,q1=np.quantile(xs,[.06,.94]);ends=[]
 for x in [q0,q1]:
  m=abs(xs-x)<=1.4;ends.append(np.array([xs[m].mean(),ys[m].mean()]))
 center=(ends[0]+ends[1])/2;delta=ends[1]-ends[0];angle=math.atan2(delta[1],delta[0]);c,s=math.cos(angle),math.sin(angle)
 dx,dy=xs-center[0],ys-center[1];u=dx*c+dy*s;v=-dx*s+dy*c
 grid=np.linspace(u.min(),u.max(),41);upper=[];lower=[]
 for at in grid:
  near=v[abs(u-at)<1.8];upper.append(near.min()-.3);lower.append(near.max()+.3)
 wide=np.linspace(grid[0]-9,grid[-1]+9,49);top=np.interp(wide,grid,upper);bottom=np.maximum(top+1,np.interp(wide,grid,lower))
 yy,xx=np.where(lid[:,:,3]>32);dx,dy=xx-center[0],yy-center[1];lu=dx*c+dy*s;lv=-dx*s+dy*c;weights=lid[yy,xx,3]/255*np.clip((190-lid[yy,xx,1].astype(float))/100,0,1)
 closed_grid=np.linspace(max(lu.min(),wide[0]),min(lu.max(),wide[-1]),49);closed=[]
 for at in closed_grid:
  m=abs(lu-at)<2;closed.append(np.average(lv[m],weights=weights[m]) if m.any() and weights[m].sum()>0 else np.nan)
 ok=np.isfinite(closed);closed=np.interp(closed_grid,closed_grid[ok],np.array(closed)[ok]);curve=np.interp(wide,closed_grid,closed)
 point={'cx':float(center[0]),'cy':float(center[1])}
 return {'center':point,'angleDeg':math.degrees(angle),'u0':float(wide[0]),'u1':float(wide[-1]),'upper':top.tolist(),'lower':bottom.tolist(),'closed':curve.tolist(),'closedSource':point,'closedTarget':point,'closedRotationDeg':0},[e.tolist() for e in ends]
