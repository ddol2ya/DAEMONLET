"""Assemble pose-local See-through layers and source-specific expression sheets.

Only the selected run is read for artwork. Layer-ab helpers provide pixel and PSD
operations; no previous character model, coordinates or dialogue is consumed.
"""
import argparse, json, math, sys, subprocess, datetime
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent/'lib'))
from prepare import checked_root, write, sha
from build_base_pose_a import load_layers, box, visibility, compose
from build_own_pose_models import correct_visible, feather, over, canon
from build_a import largest
from refine_base_face_a import holes
from source_eye_blinks import rebuild_lid, make_profile

read = lambda p: json.loads(p.read_text())
YY, XX = np.indices((1280, 1280))
def grow(mask, size=3):
    return np.array(Image.fromarray(np.uint8(np.clip(mask,0,1)*255)).filter(ImageFilter.MaxFilter(size)))/255

def roi(bounds):
    x0,y0,x1,y1 = map(int,bounds); m = np.zeros((1280,1280),bool)
    m[max(0,y0):min(1280,y1),max(0,x0):min(1280,x1)] = True
    return m

def sprite(source, alpha):
    result=source.copy(); result[:,:,3]=np.uint8(np.clip(np.rint(alpha*255),0,255))
    result[result[:,:,3]==0,:3]=0
    return result

def weighted_center(mask):
    total=mask.sum(); assert total>0
    return np.array([(XX*mask).sum()/total,(YY*mask).sum()/total])

def mouth_feature(source, bounds):
    x0,y0,x1,y1=map(int,bounds); patch=source[y0:y1,x0:x1,:3].astype(float)
    border=np.ones(patch.shape[:2],bool);border[3:-3,3:-3]=False
    skin=np.median(patch[border],axis=0)
    contrast=np.maximum(0,skin[1]-patch[:,:,1])+.5*np.maximum(0,(patch[:,:,0]-patch[:,:,1])-(skin[0]-skin[1]))
    local=largest(contrast>max(7,float(contrast.max())*.24))
    assert local.sum()>3,'Empty source-specific mouth'
    b=box(local); b=[x0+b[0],y0+b[1],x0+b[2],y0+b[3]]
    alpha=feather(roi([b[0]-3,b[1]-2,b[2]+3,b[3]+3]),.8)*roi(bounds)
    return sprite(source,alpha),b

def register_panel(source, panel, nose_bounds):
    x0,y0,x1,y1=nose_bounds; target=source[y0:y1,x0:x1,:3].astype(float)
    best=None
    for dy in range(-12,13):
        for dx in range(-12,13):
            sample=panel[y0-dy:y1-dy,x0-dx:x1-dx,:3].astype(float)
            if sample.shape!=target.shape: continue
            score=float(np.mean(((target-target.mean((0,1)))-(sample-sample.mean((0,1))))**2)+.15*np.mean((target-sample)**2))
            if best is None or score<best[0]:best=(score,dx,dy)
    score,dx,dy=best
    shifted=np.array(Image.fromarray(panel).transform((1280,1280),Image.Transform.AFFINE,(1,0,-dx,0,1,-dy),Image.Resampling.BICUBIC))
    return shifted,{'translation':[dx,dy],'score':score,'nose_bounds':nose_bounds}

def select_iris_mask(native_iris, core):
    return holes(largest((native_iris[:,:,3]>32)&core))

def neutral_features(raw, source, geometry):
    rgb=source[:,:,:3].astype(float);parts={};anchors={};records=[]
    for side,key in [('l','eyeL'),('r','eyeR')]:
        lash=raw['eyelash-'+side];lb=box(lash[:,:,3]>12)
        region=roi([lb[0]-5,lb[1]-4,lb[2]+5,lb[3]+6])
        allowed=(rgb[:,:,2]-rgb[:,:,0]>-42)&(rgb.mean(2)>65)&region
        native_white=raw.get('eyewhite-'+side)
        source_bounds=geometry.get('sourceEyeApertures',{}).get(side)
        if source_bounds:
            # Explicitly reviewed source bounds may recover a part omitted by
            # decomposition; all visible aperture/iris pixels still come from
            # this pose. Exclude its dark brown liner and warm cheek pixels.
            source_core=allowed&roi(source_bounds)&(((rgb[:,:,0]-rgb[:,:,1]<42)&(rgb[:,:,1]>145))|(rgb[:,:,2]>rgb[:,:,0]+3))
            native_lid=np.array(Image.fromarray(np.uint8(lash[:,:,3]>10)*255).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5)))>0
            source_core&=holes(largest(native_lid))
            core=holes(largest(source_core))
            native_white=np.zeros_like(source)
        else:
            assert native_white is not None,'Native eye white missing; inspect and provide own sourceEyeApertures: '+side
            core=holes(largest((native_white[:,:,3]>55)&allowed))
        assert core.sum()>60,'Empty eye aperture: '+side
        aperture=feather(core,.3);ab=box(aperture>.5)
        iris_mask=select_iris_mask(raw['irides-'+side],core)
        assert iris_mask.sum()>20,'Source iris is missing: '+side
        ib=box(iris_mask);cx=(ib[0]+ib[2]-1)/2
        native_iris=raw['irides-'+side];cy=float(weighted_center(native_iris[:,:,3])[1])
        assert ab[1]-8<cy<ab[3]+10,'Native iris center is outside source eye'
        radius=(ib[2]-ib[0])/2+.6;nb=box(native_iris[:,:,3]>32)
        b=[math.floor(cx-radius-2),math.floor(cy-radius-2),math.ceil(cx+radius+2),math.ceil(cy+radius+2)]
        fill=np.array(Image.fromarray(native_iris).crop(nb).resize((b[2]-b[0],b[3]-b[1]),Image.Resampling.LANCZOS))
        iris=np.zeros_like(source);iris[b[1]:b[3],b[0]:b[2]]=fill
        visible=feather(iris_mask,.25);iris[:,:,:3]=np.uint8(np.rint(iris[:,:,:3]*(1-visible[:,:,None])+rgb*visible[:,:,None]))
        iris[:,:,3]=np.uint8(np.rint(np.clip(radius+.5-np.hypot(XX-cx,YY-cy),0,1)*255))
        valid_white=core&~(grow(iris_mask,3)>.01)&(rgb.mean(2)>170)
        samples=rgb[valid_white];assert len(samples)>4,'Insufficient own eye-white pixels'
        white=np.zeros_like(source);white[:,:,:3]=np.uint8(np.median(samples,axis=0))
        own=native_white[:,:,3]>80;neutral=(native_white[:,:,:3].mean(2)>175)&(native_white[:,:,2].astype(float)-native_white[:,:,0]<20)
        white[own&neutral,:3]=native_white[own&neutral,:3]
        white[valid_white,:3]=source[valid_white,:3];white[:,:,3]=np.uint8(np.rint(aperture*255))
        line=((rgb[:,:,0]-rgb[:,:,1]>30)&(rgb[:,:,1]<185)&(rgb[:,:,0]>rgb[:,:,2]-3))&(grow(lash[:,:,3]/255,5)>.05)&region
        line_alpha=feather(grow(line,3),.25)*(1-aperture)
        parts.update({'eyewhite-'+side:white,'irides-'+side:iris,'eyelash-'+side:sprite(source,line_alpha)})
        if 'eyebrow-'+side in raw:parts['eyebrow-'+side]=sprite(source,raw['eyebrow-'+side][:,:,3]/255)
        anchors[key]={'x0':ab[0],'x1':ab[2]-1,'y0':ab[1],'y1':ab[3]-1,'icx':cx,'icy':cy,'closeY':ab[3]-2}
        records.append({'side':side,'aperture_bounds':ab,'visible_iris_bounds':ib,'iris_center':[cx,cy],'iris_radius':radius,'source_iris_pixels':int(iris_mask.sum()),'aperture_source':'reviewed own source colour mask' if source_bounds else 'own native aperture constrained to source colour'})
    mb=box(raw['mouth_close'][:,:,3]>16)
    if geometry.get('neutralMouthBounds'):
        b=geometry['neutralMouthBounds'];mouth=sprite(source,feather(roi([b[0]-2,b[1]-2,b[2]+2,b[3]+2]),.8))
    else:
        mouth,b=mouth_feature(source,[mb[0]-7,mb[1]-5,mb[2]+7,mb[3]+5])
    parts['mouth_close']=mouth
    anchors['mouth']={'x0':b[0]-2,'x1':b[2]+2,'y0':b[1]-2,'y1':b[3]+2,'cx':(b[0]+b[2]-1)/2,'cy':(b[1]+b[3]-1)/2}
    return parts,anchors,records

def add_expressions(d,raw,source,parts,anchors):
    request=read(d/'plan/own-expression-request.json');atlas=Image.open(d/'raw/own-expression-G0.png').convert('RGBA');w,h=atlas.size
    assert abs(w/h-2)<.03,'Expression sheet lost its two-panel layout'
    crop=request['source_canvas_crop'];cw,ch=crop[2]-crop[0],crop[3]-crop[1];panels=[];registrations=[]
    nb=box(raw['nose'][:,:,3]>8);nb=[nb[0]-2,nb[1]-2,nb[2]+3,nb[3]+3]
    for index in range(2):
        panel=atlas.crop((round(index*w/2),0,round((index+1)*w/2),h)).resize((cw,ch),Image.Resampling.LANCZOS)
        full=Image.new('RGBA',(1280,1280));full.paste(panel,crop[:2]);registered,record=register_panel(source,np.array(full),nb);panels.append(registered);registrations.append(record)
    for side,key in [('l','eyeL'),('r','eyeR')]:
        lid,_=rebuild_lid(panels[0],anchors[key],side)
        parts['eye_close-'+side]=lid
        anchors[key]['closeY']=float(weighted_center(lid[:,:,3])[1])
    add_mouth_expressions(panels,parts,anchors)
    return registrations

def add_mouth_expressions(panels,parts,anchors):
    a=anchors['mouth'];mc=np.array([a['cx'],a['cy']]);neutral_width=a['x1']-a['x0']
    for name,index in [('mouth_open',0),('mouth_smile',1)]:
        half_width=max(30,min(43,neutral_width*1.4))
        ar,b=mouth_feature(panels[index],[int(mc[0]-half_width),int(mc[1]-18),int(mc[0]+half_width+1),int(mc[1]+19)])
        width=float(np.clip(neutral_width*.85,16,32)) if name=='mouth_open' else float(np.clip(neutral_width*1.12,22,45))
        scale=width/(b[2]-b[0]);center=np.array([(b[0]+b[2]-1)/2,(b[1]+b[3]-1)/2]);offset=mc-scale*center
        parts[name]=np.array(Image.fromarray(ar).transform((1280,1280),Image.Transform.AFFINE,(1/scale,0,-offset[0]/scale,0,1/scale,-offset[1]/scale),Image.Resampling.BICUBIC))

def blink_profiles(parts,anchors):
    for side,key in [('l','eyeL'),('r','eyeR')]:
        profile,_=make_profile(parts['eyewhite-'+side],parts['eye_close-'+side])
        anchors[key]['blink']=profile


def build(root, spec, round_name):
    pid=spec['id'];d=root/'poses'/pid;out=d/round_name
    assert not out.exists(),'Preserve prior rounds; choose a new output round'
    (out/'layers').mkdir(parents=True);(out/'masks').mkdir()
    source=np.array(Image.open(d/'inputs/master.png').convert('RGBA'));geometry=read(d/'plan/geometry.json')
    assert read(d/'native/generation.json')['sourceSha256']==sha(d/'inputs/master.png')
    raw,order,native_files=load_layers(d/'native',read(next((d/'native').glob('*_layers.json'))),pose_local_sides=True)
    for ar in raw.values():ar[ar[:,:,3]<8]=0;ar[:,:,3]=np.uint8(np.rint(ar[:,:,3]*(source[:,:,3]/255)))
    for name,target in geometry.get('mergeNativeParts',{}).items():
        if name in raw:raw[target]=over([raw[target],raw.pop(name)])
    for name in geometry.get('discardNativeParts',[]):raw.pop(name,None)
    for name,bounds in geometry.get('partBounds',{}).items():
        if name in raw:raw[name][:,:,3]*=roi(bounds)
    for name in ['face','front hair','back hair','nose','eyelash-l','eyelash-r','irides-l','irides-r']:
        assert name in raw and (raw[name][:,:,3]>8).sum()>4,'Required own native part missing: '+name
    features,anchors,eye_records=neutral_features(raw,source,geometry)
    registrations=add_expressions(d,raw,source,features,anchors);blink_profiles(features,anchors)
    parts={n:a for n,a in raw.items() if not n.startswith(('eye','irides','mouth')) and n not in ['background']};parts.update(features)
    preferred=['back hair','body','legwear','neck','ears-l','ears-r','topwear','bottomwear','handwear-r','handwear-l','objects','nose','face']
    preferred+=['eyewhite-l','irides-l','eyelash-l','eyewhite-r','irides-r','eyelash-r','eyebrow-l','eyebrow-r','mouth_close','eye_close-l','eye_close-r','mouth_open','mouth_smile','front hair']
    # Nose belongs over the own skin plate. Hand touching hair belongs over hair.
    preferred.remove('nose');preferred.insert(preferred.index('face')+1,'nose')
    front_hands=geometry.get('frontHands',['handwear-l'] if pid=='head-tap' else [])
    for name in front_hands:
        preferred.remove(name);preferred.append(name)
    order=[n for n in preferred if n in parts]
    extras=[n for n in parts if n not in order]
    order[order.index('face'):order.index('face')]=extras
    excluded=np.zeros((1280,1280),bool)
    for n,ar in {**raw,**features}.items():
        if n.startswith(('eye','irides','mouth')):excluded|=grow(ar[:,:,3]/255,17)>.02
    neutral=[n for n in order if not n.startswith('eye_close') and n not in ['mouth_open','mouth_smile']]
    healed=correct_visible(parts,neutral,source,excluded)
    overrides={'layerOrder':[canon(n) for n in order],'cleanupThresholds':{canon(n):1 for n in parts},'depthOverrides':{'front hair':1,'back hair':1,'ears':1},'deformationSources':{'neck':'topwear'},'blinkRepair':{'enabled':False},'mouthExpressions':{'neutral':'mouth_close','open':'mouth_open','smile':'mouth_smile'},'anchorOverrides':anchors,'interactionAreas':geometry['interactionAreas'],'excludeAfterMeshResolution':[]}
    if 'headFollowLayers' in geometry:overrides['headFollow']=geometry['headFollowLayers']
    elif pid=='head-tap':overrides['headFollow']={'handwear_1':geometry['headFollow']}
    for name in extras:overrides.setdefault('groupOverrides',{})[canon(name)]='body'
    rows=[]
    for n in order:
        ar=parts[n];ar[ar[:,:,3]==0,:3]=0
        if not ar[:,:,3].any():continue
        b=box(ar[:,:,3]>0);file='layers/'+n.replace(' ','_')+'.png';Image.fromarray(ar).crop(b).save(out/file)
        row={'name':n,'filename':file,'left':b[0],'top':b[1],'right':b[2],'bottom':b[3]}
        if n.startswith('irides-'):row['clipTo']=n.replace('irides-','eyewhite-')
        rows.append(row)
    write(out/'layers.json',{'width':1280,'height':1280,'layers':rows});write(out/'rig-overrides.json',overrides)
    pose={'schemaVersion':1,'id':pid,'label':spec['label'],'source':'../inputs/master.png','psd':'model.psd','overrides':'rig-overrides.json','strategy':'independent-model','registration':{'strategy':'identity','maxScaleDelta':0,'maxRotationDeg':0,'maxAnchorErrorPx':0},'layers':{'sharedFromBase':[],'replaceFromBase':[],'useFromPose':[],'addFromPose':[]},'transition':{'enterMs':300,'exitMs':280,'swapStart':.35,'swapEnd':.65},'motion':{'loopDurationMs':4000,'playback':'loop','transition':'continuous','parameters':{'armY':{'type':'constant','value':0},'armPos':{'type':'constant','value':0}},'layers':{}},'interactionScale':{'HEAD_TAP':1,'TORSO_TAP':1}}
    write(out/'pose.json',pose);write(out/'model.json',{'schemaVersion':1,'id':pid,'label':spec['label'],'psd':'model.psd','overrides':'rig-overrides.json','pose':'pose.json','bodySource':'../inputs/master.png','excludeAfterMeshResolution':[],'noExternalBaseModel':True})
    write(out/'provenance.json',{'pose':pid,'round':round_name,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source_master_sha256':sha(d/'inputs/master.png'),'native_source_files':native_files,'source_face_art':{'eyes':eye_records},'expression_sheet_sha256':sha(d/'raw/own-expression-G0.png'),'expression_registration':registrations,'shared_Base_eye_mouth_layers':0,'shared_body_layers':[],'alpha_healing_pixels':healed,'unclassified_native_parts':extras,'script_sha256':sha(__file__),'status':'assembled_pending_visual_QA_and_motion'})
    subprocess.run(['node',str(REPO/'scripts/characters/export-model-psd.mjs'),str(out)],cwd=REPO,check=True)
    print(json.dumps({'pose':pid,'round':round_name,'layers':len(rows),'eye_centers':[[anchors[k]['icx'],anchors[k]['icy']] for k in ['eyeL','eyeR']],'mouth':[anchors['mouth']['cx'],anchors['mouth']['cy']]},ensure_ascii=False),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root');parser.add_argument('--pose');parser.add_argument('--round',default='N0');args=parser.parse_args();root=checked_root(args.root)
    for spec in read(root/'plan/poses.json')['poses']:
        if not args.pose or spec['id']==args.pose:build(root,spec,args.round)
