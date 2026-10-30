import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.venv', 'Scripts', 'python.exe');
const python = process.env.LOCALFOLD_PYTHON || (existsSync(local) ? local : 'python3');
const script = String.raw`
import base64,io,json,random,sys
sys.path.insert(0,'python')
from PIL import Image,ImageCms
from image_resize import resize_image,ImageResizeError

def probe(request):
 try:
  kind=request.get('kind','opaque'); rng=random.Random(1234); out=io.BytesIO()
  if kind=='noise':
   source=Image.frombytes('RGB',(320,240),rng.randbytes(320*240*3)); source.save(out,format='BMP')
  elif kind=='transparent':
   source=Image.new('RGBA',(400,200),(20,100,200,255)); source.putalpha(Image.frombytes('L',source.size,bytes(0 if i%400<100 else 255 for i in range(400*200))))
   source.save(out,format='PNG')
  elif kind=='oriented':
   source=Image.new('RGB',(400,200),'red'); exif=Image.Exif(); exif[274]=6;exif[270]='private synthetic camera note'
   source.save(out,format='JPEG',exif=exif)
  elif kind in ('gif','gif-once','poster','webp-animation'):
   images=[Image.new('RGB',(128,96),color) for color in ('red','green','blue')]
   if kind=='poster':images[0].save(out,format='PNG',save_all=True,append_images=images[1:],default_image=True,duration=[200,300],loop=2)
   elif kind=='webp-animation':images[0].save(out,format='WEBP',save_all=True,append_images=images[1:],duration=[120,230,340],loop=3,lossless=True)
   else:images[0].save(out,format='GIF',save_all=True,append_images=images[1:],duration=[120,230,340],**({'loop':3} if kind=='gif' else {}))
  elif kind=='tiff':
   images=[Image.new('RGB',(400,200),'red'),Image.new('RGB',(300,400),'blue'),Image.new('RGB',(200,300),'green')]
   images[0].save(out,format='TIFF',save_all=True,append_images=images[1:])
  elif kind=='gray16':
   source=Image.new('I;16',(160,80)); source.putdata([x*400 for y in range(80) for x in range(160)]);source.save(out,format='PNG')
  elif kind=='profile':
   source=Image.new('RGB',(400,200),'red');exif=Image.Exif();exif[270]='private synthetic note'
   source.save(out,format='PNG',exif=exif,icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes())
  else:
   Image.new('RGB',(400,200),(20,100,200)).save(out,format='PNG')
  raw=out.getvalue(); payload=dict(request.get('payload',{})); payload.setdefault('file',{'name':'sample.image','data':base64.b64encode(raw).decode()})
  result=resize_image(payload); output=base64.b64decode(result.pop('data'))
  with Image.open(io.BytesIO(output)) as image:
   decoded={'format':image.format,'size':list(image.size),'dpi':image.info.get('dpi'),'exif':dict(image.getexif()),'icc':bool(image.info.get('icc_profile')),'defaultImage':image.info.get('default_image',False),'loop':image.info.get('loop'),'frames':[],'mode':image.mode}
   for i in range(121):
    try:image.seek(i)
    except EOFError:break
    image.load(); rgba=image.convert('RGBA');decoded['frames'].append({'size':list(image.size),'duration':image.info.get('duration'),'alpha':list(rgba.getextrema()[-1]),'extrema':image.getextrema()})
  return {'ok':True,'result':result,'actualBytes':len(output),'decoded':decoded}
 except ImageResizeError as error:return {'ok':False,'error':str(error)}
request=json.load(sys.stdin)
print(json.dumps([probe(item) for item in request] if isinstance(request,list) else probe(request),default=lambda value:float(value)))
`;

function call(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Resize probe timed out.')); }, 100_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Resize probe exited ${code}: ${stderr.slice(-2000)}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stdout + stderr)); } }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const dimensions = { width: 200, height: 200, unit: 'px' };
function okay(value) {
  assert.equal(value.ok, true, value.error);
  assert.equal(value.actualBytes, value.result.outputBytes);
  assert.deepEqual(value.decoded.size, [value.result.imageWidth, value.result.imageHeight]);
  assert.equal(value.decoded.frames.length, value.result.imageFrames);
  assert.equal(value.result.compressionMethod, 'image-resize');
}

test('pixel resize fits aspect-ratio bounds and exact mode produces the requested dimensions', async () => {
  const [fit, exact, upscale] = await call([
    { payload: dimensions },
    { payload: { ...dimensions, maintainAspectRatio: false } },
    { payload: { width: 800, height: 600 } },
  ]);
  for (const result of [fit, exact, upscale]) okay(result);
  assert.deepEqual(fit.decoded.size, [200, 100]);
  assert.deepEqual(exact.decoded.size, [200, 200]);
  assert.deepEqual(upscale.decoded.size, [800, 400]);
  assert.equal(fit.result.imageTargetEnabled, false);
  assert.equal('targetReached' in fit.result, false);
});

test('centimetres use requested DPI and embed resolution in the downloaded image before sizing', async () => {
  const values = await call(['png', 'jpeg', 'webp', 'avif'].map(outputFormat => ({
    payload: { width: 5.08, height: 2.54, unit: 'cm', dpi: 300, outputFormat },
  })));
  for (const value of values) {
    okay(value);
    assert.deepEqual(value.decoded.size, [600, 300]);
    assert.equal(value.result.imageDpi, 300);
    const dpi = value.decoded.dpi || [value.decoded.exif['282'], value.decoded.exif['283']];
    assert.ok(Math.abs(dpi[0] - 300) < .01 && Math.abs(dpi[1] - 300) < .01);
    assert.equal(value.decoded.exif['270'], undefined);
  }
  const [half] = await call([{ payload: { width: 1.00125, height: 1.00125, unit: 'cm', dpi: 1016, maintainAspectRatio: false, outputFormat: 'png' } }]);
  okay(half);
  assert.deepEqual(half.decoded.size, [401, 401]);
});

test('target-size encoding preserves fixed dimensions for both feasible and impossible maxima', { timeout: 120_000 }, async () => {
  const [fit, miss] = await call([
    { kind: 'noise', payload: { width: 160, height: 120, targetBytes: 7000, outputFormat: 'webp' } },
    { kind: 'noise', payload: { width: 320, height: 240, targetBytes: 1000, outputFormat: 'png' } },
  ]);
  okay(fit); okay(miss);
  assert.equal(fit.result.targetReached, true);
  assert.ok(fit.actualBytes <= 7000);
  assert.deepEqual(fit.decoded.size, [160, 120]);
  assert.equal(miss.result.targetReached, false);
  assert.ok(miss.actualBytes > 1000);
  assert.deepEqual(miss.decoded.size, [320, 240]);
  assert.match(miss.result.resultMessage, /could not be reached at the requested dimensions/);
});

test('resize applies EXIF orientation before aspect fitting and keeps transparency and color profiles', async () => {
  const [oriented, alpha, profile, rejected] = await call([
    { kind: 'oriented', payload: { width: 100, height: 100, outputFormat: 'png' } },
    { kind: 'transparent', payload: { ...dimensions, outputFormat: 'webp' } },
    { kind: 'profile', payload: { ...dimensions, outputFormat: 'png' } },
    { kind: 'transparent', payload: { ...dimensions, outputFormat: 'jpeg' } },
  ]);
  okay(oriented); okay(alpha); okay(profile);
  assert.deepEqual(oriented.decoded.size, [50, 100]);
  assert.equal(oriented.decoded.exif['274'], undefined);
  assert.deepEqual(alpha.decoded.frames[0].alpha, [0, 255]);
  assert.equal(profile.decoded.icc, true);
  assert.equal(profile.decoded.exif['270'], undefined);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /transparency/);
});

test('GIF and APNG resize retain every frame, play-once behavior and poster timing', async () => {
  const [gif, once, poster, rejected] = await call([
    { kind: 'gif', payload: { width: 64, height: 48 } },
    { kind: 'gif-once', payload: { width: 64, height: 48 } },
    { kind: 'poster', payload: { width: 64, height: 48 } },
    { kind: 'gif', payload: { width: 64, height: 48, outputFormat: 'webp' } },
  ]);
  for (const value of [gif, once, poster]) {
    okay(value); assert.equal(value.decoded.frames.length, 3);
    assert.ok(value.decoded.frames.every(frame => frame.size[0] === 64 && frame.size[1] === 48));
  }
  assert.equal(gif.decoded.loop, 3);
  assert.equal(once.decoded.loop, null);
  assert.deepEqual(gif.decoded.frames.map(frame => frame.duration), [120, 230, 340]);
  assert.equal(poster.decoded.defaultImage, true);
  assert.equal(poster.decoded.loop, 2);
  assert.deepEqual(poster.decoded.frames.slice(1).map(frame => frame.duration), [200, 300]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /timing|poster/);
});

test('multipage TIFF resize fits every page and rejects excessive transformed pixel allocations', async () => {
  const [fitted, exact, tooLarge] = await call([
    { kind: 'tiff', payload: { width: 5.08, height: 5.08, unit: 'cm', dpi: 300 } },
    { kind: 'tiff', payload: { width: 120, height: 100, maintainAspectRatio: false } },
    { kind: 'tiff', payload: { width: 5000, height: 5000, maintainAspectRatio: false } },
  ]);
  okay(fitted); okay(exact);
  assert.equal(fitted.decoded.frames.length, 3);
  assert.deepEqual(exact.decoded.frames.map(frame => frame.size), [[120, 100], [120, 100], [120, 100]]);
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error, /60 million pixels/);
});

test('16-bit grayscale resize retains precision and refuses precision-losing conversion', async () => {
  const [gray, rejected] = await call([
    { kind: 'gray16', payload: { width: 80, height: 40, outputFormat: 'png' } },
    { kind: 'gray16', payload: { width: 80, height: 40, outputFormat: 'jpeg' } },
  ]);
  okay(gray);
  assert.ok(gray.decoded.frames[0].extrema[1] > 50000);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /16-bit/);
});

test('resize validates dimension units, DPI, flags, targets and file data before unsafe processing', async () => {
  const invalid = [
    { width: true }, { width: '200' }, { width: 0 }, { width: -1 }, { width: 1.5 },
    { height: null }, { unit: 'inch' }, { dpi: 0 }, { dpi: 1201 }, { maintainAspectRatio: 'false' },
    { width: 30001 }, { width: 10000, height: 10000 }, { width: .0001, height: .0001, unit: 'cm' },
    { targetBytes: true }, { targetBytes: '1000' }, { targetBytes: 999 }, { targetBytes: 1000.5 }, { targetBytes: 16777217 },
    { outputFormat: 'svg' }, { file: null }, { file: { name: 'bad.png', data: 'invalid!' } },
  ];
  const results = await call(invalid.map(value => ({ payload: { ...dimensions, ...value } })));
  assert.ok(results.every(value => value.ok === false));
});
