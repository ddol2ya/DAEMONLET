"""Prepare/import fixed-coordinate, pose-local hair and skin repair sheets."""
import argparse,json,shutil,sys,subprocess,datetime
from pathlib import Path
import numpy as np
from PIL import Image,ImageFilter
REPO=Path(__file__).resolve().parents[2];sys.path.insert(0,str(Path(__file__).resolve().parent/'lib'))
from prepare import checked_root,write,sha
from assemble_finish_art import chroma_matte,match_face_contour,despill_edges,bounds
read=lambda p:json.loads(p.read_text())

def prepare(root,pid,source_round,target_round):
 d=root/'poses'/pid;source=d/source_round;target=d/target_round
 assert source.is_dir() and not target.exists();shutil.copytree(source,target)
 meta=read(source/'layers.json');atlas=Image.new('RGBA',(2048,2048),'#00ff00');parts=[]
 for index,name in enumerate(['front hair','face','back hair']):
  row=next(x for x in meta['layers'] if x['name']==name);original=Image.open(source/row['filename']).convert('RGBA');scale=min(875/original.width,890/original.height);size=[round(original.width*scale),round(original.height*scale)];xy=[index%2*1024+(1024-size[0])//2,index//2*1024+(1024-size[1])//2]
  atlas.alpha_composite(original.resize(size,Image.Resampling.LANCZOS),xy);parts.append({'name':name,'cell':index,'source_bounds':[row[k] for k in ['left','top','right','bottom']],'atlas_bounds':xy+[xy[0]+size[0],xy[1]+size[1]],'source_file':row['filename'],'source_sha256':sha(source/row['filename'])})
 crop=read(d/'plan/own-expression-request.json')['source_canvas_crop'];reference=Image.open(d/'inputs/master.png').convert('RGBA').crop(crop);reference.thumbnail((930,930),Image.Resampling.LANCZOS);reference=reference.resize((930,930),Image.Resampling.LANCZOS);atlas.alpha_composite(reference,(1071,1071))
 file=d/'raw'/f'finish-{target_round}-edit-target.png';atlas.convert('RGB').save(file)
 prompt=(f'Use case: precise-object-edit. Edit this fixed four-cell sprite repair sheet for the {pid} pose of one original adult anime character. The lower-right cell is the authoritative source portrait; leave it unchanged. Correct only the separated parts in the other three cells. Keep each part centered at its exact existing cell position and scale; do not rearrange the sheet. '
 'UPPER LEFT, FRONT HAIR: reproduce the source portrait\'s exact fringe, side-lock shapes and hair colors. Remove checkerboard remnants, gray fringe, skin-colored patches, holes and misplaced extra strands. The lower bang tips must end exactly where they do in the source portrait, preserving the visible eyes. Preserve the source\'s strand direction, any accent strands visible in the source, soft highlights and fine painted linework. '
 'UPPER RIGHT, FACE SKIN: a smooth featureless face skin plate of the exact same outline, tilt and scale. Remove every facial feature, nose mark, hair strand and discoloration from this plate. Preserve warm soft cheeks and the delicate jaw contour. No eyes, eyebrows, nose, lips, ears, neck or hair on this skin plate. It sits behind separate unchanged facial features. '
 'LOWER LEFT, BACK HAIR: rebuild only the source portrait\'s back-hair silhouette, hanging locks and accessories. Remove all skin, clothing, checkerboard fragments and unrelated long-hair extensions. Match the source style, colors and outer shape. Complete the small hidden backing behind the head without adding another face or bangs. '
 'Keep every asset isolated in its existing cell on perfectly uniform vivid green #00FF00, including true gaps between hair strands. No green reflected tint, shadows, checkerboard, labels, text, borders, extra parts or extra panels. Keep the same square 2-by-2 sheet composition. This is a local cleanup of these own-pose parts, not a new character design.')
 request={'pose':pid,'tool':'built-in image_gen','input':str(file.resolve()),'input_sha256':sha(file),'prompt':prompt,'source_round':source_round,'target_round':target_round,'atlas_size':[2048,2048],'parts':parts,'status':'prepared'};write(d/'plan'/f'finish-{target_round}-request.json',request)
 print(json.dumps({'pose':pid,'request':str(d/'plan'/f'finish-{target_round}-request.json'),'input':str(file.resolve())}))

def adopt(root,pid,target_round):
 d=root/'poses'/pid;request=read(d/'plan'/f'finish-{target_round}-request.json');source=d/request['source_round'];out=d/target_round;raw=d/'raw'/f'finish-{target_round}-G0.png';generated=Image.open(raw).convert('RGBA');w,h=generated.size;assert abs(w/h-1)<.03
 meta=read(out/'layers.json');ov=read(out/'rig-overrides.json');records=[]
 for part in request['parts']:
  index=part['cell'];cell=[round(index%2*w/2),round(index//2*h/2),round((index%2+1)*w/2),round((index//2+1)*h/2)];pixels=chroma_matte(generated.crop(cell));row=next(x for x in meta['layers'] if x['name']==part['name']);old=Image.open(source/row['filename']).convert('RGBA');sb=part['source_bounds'];size=(sb[2]-sb[0],sb[3]-sb[1]);ab=part['atlas_bounds']
  sx=(ab[2]-ab[0])/size[0]*w/2048;sy=(ab[3]-ab[1])/size[1]*h/2048;tx=ab[0]*w/2048-cell[0];ty=ab[1]*h/2048-cell[1]
  new=Image.fromarray(pixels).transform(size,Image.Transform.AFFINE,(sx,0,tx,0,sy,ty),Image.Resampling.BICUBIC)
  if part['name']=='face':
   new=match_face_contour(new,old);a=np.array(new);original=np.array(old);yy,xx=np.indices(a.shape[:2]);cy=yy+row['top'];cx=xx+row['left'];inside=np.array(new.getchannel('A').filter(ImageFilter.MinFilter(9)))>240;eye_top=min(ov['anchorOverrides'][k]['y0'] for k in ['eyeL','eyeR']);keep=inside&(cy>eye_top-12)&(original[:,:,3]>250)
   nose=next(x for x in meta['layers'] if x['name']=='nose');keep&=~((cx>nose['left']-5)&(cx<nose['right']+5)&(cy>nose['top']-4)&(cy<nose['bottom']+4));mix=np.array(Image.fromarray(np.uint8(keep)*255).filter(ImageFilter.GaussianBlur(1.3)))/255;a[:,:,:3]=np.uint8(np.rint(a[:,:,:3]*(1-mix[:,:,None])+original[:,:,:3]*mix[:,:,None]));cutoff=min(x['top'] for x in meta['layers'] if x['name'].startswith('eyebrow'))-42;coverage=np.clip((cy-cutoff)/14,0,1);coverage=coverage*coverage*(3-2*coverage);a[:,:,3]=np.uint8(np.rint(a[:,:,3]*coverage));new=Image.fromarray(a)
  new,despilled=despill_edges(new);new.save(out/row['filename']);records.append({'name':part['name'],'input_sha256':part['source_sha256'],'output_sha256':sha(out/row['filename']),'dimensions_unchanged':new.size==old.size,'source_bounds':sb,'placement':'Original input atlas transform; no re-normalization to output foreground bounds','despilled_pixels':despilled})
 changed={x['name'] for x in request['parts']};unchanged=[{'name':row['name'],'sha256':sha(out/row['filename'])} for row in meta['layers'] if row['name'] not in changed];assert all(sha(source/row['filename'])==sha(out/row['filename']) for row in meta['layers'] if row['name'] not in changed)
 write(out/'finish-art-audit.json',{'pose':pid,'generated_sha256':sha(raw),'parts':records,'unchanged':unchanged,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()});prov=read(out/'provenance.json');prov.update(round=target_round,finish_art='finish-art-audit.json',status='finish_pending_runtime_QA');write(out/'provenance.json',prov)
 subprocess.run(['node',str(REPO/'scripts/characters/export-model-psd.mjs'),str(out)],cwd=REPO,check=True);print(json.dumps({'pose':pid,'round':target_round,'changed_parts':len(records),'unchanged_parts':len(unchanged)}))

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['prepare','adopt']);p.add_argument('root');p.add_argument('--pose');p.add_argument('--source-round',default='N1');p.add_argument('--round',default='N2');a=p.parse_args();r=checked_root(a.root)
 for spec in read(r/'plan/poses.json')['poses']:
  if a.pose and spec['id']!=a.pose:continue
  if a.mode=='prepare':prepare(r,spec['id'],a.source_round,a.round)
  else:adopt(r,spec['id'],a.round)
