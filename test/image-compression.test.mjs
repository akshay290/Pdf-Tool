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
from image_compression import compress_image,ImageCompressionError
request=json.load(sys.stdin)
try:
 if request['op']=='compress':
  response=compress_image(request['payload'])
 elif request['op']=='fixture':
  kind=request['kind']; out=io.BytesIO(); rng=random.Random(19)
  if kind in ('noise','transparent'):
   image=Image.frombytes('RGB',(320,240),rng.randbytes(320*240*3))
   if kind=='transparent':
    image=image.convert('RGBA'); image.putalpha(Image.frombytes('L',image.size,bytes(0 if i%11==0 else 255 for i in range(320*240))))
   image.save(out,format='PNG' if kind=='transparent' else 'BMP')
  elif kind=='oriented':
   image=Image.new('RGB',(80,40),'navy'); exif=Image.Exif(); exif[274]=6; exif[270]='private camera description'
   image.save(out,format='JPEG',exif=exif)
  elif kind=='profile':
   image=Image.new('RGB',(24,20),(12,110,220)); exif=Image.Exif(); exif[270]='private location note'*500
   profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
   image.save(out,format='PNG',exif=exif,icc_profile=profile)
  elif kind in ('gif','gif-once'):
   images=[Image.frombytes('RGB',(128,96),rng.randbytes(128*96*3)) for _ in range(3)]
   loop_options={'loop':3} if kind=='gif' else {}
   images[0].save(out,format='GIF',save_all=True,append_images=images[1:],duration=[120,230,340],**loop_options)
  elif kind=='apng-poster':
   images=[Image.frombytes('RGB',(128,96),rng.randbytes(128*96*3)) for _ in range(3)]
   images[0].save(out,format='PNG',save_all=True,append_images=images[1:],default_image=True,duration=[200,300],loop=2)
  elif kind=='animated-avif':
   images=[Image.frombytes('RGB',(128,96),rng.randbytes(128*96*3)) for _ in range(2)]
   images[0].save(out,format='AVIF',quality=90,speed=8,max_threads=2,save_all=True,append_images=images[1:],duration=[120,230])
  elif kind=='tiff':
   image=Image.new('RGB',(256,128),'red'); second=Image.new('RGB',(192,144),'blue')
   image.save(out,format='TIFF',save_all=True,append_images=[second])
  elif kind=='many-tiff':
   images=[Image.new('RGB',(8,8),(i*7%256,i*11%256,i*13%256)) for i in range(24)]
   images[0].save(out,format='TIFF',save_all=True,append_images=images[1:])
  elif kind=='gray16':
   image=Image.new('I;16',(160,80)); image.putdata([i%160*400 for i in range(160*80)])
   image.save(out,format='TIFF',compression='raw')
  elif kind=='large-photo':
   Image.new('RGB',(8000,6000),(20,100,200)).save(out,format='JPEG',quality=90)
  elif kind in ('heif','multi-heif'):
   image=Image.frombytes('RGB',(96,64),rng.randbytes(96*64*3))
   extra=[Image.new('RGB',(96,64),'blue')] if kind=='multi-heif' else []
   image.save(out,format='HEIF',quality=90,save_all=bool(extra),append_images=extra)
  elif kind=='too-wide':
   Image.new('RGB',(30001,1),'red').save(out,format='PNG')
  else:
   Image.new('RGB',(80,50),'red').save(out,format=kind)
  response={'data':base64.b64encode(out.getvalue()).decode()}
 elif request['op']=='inspect':
  with Image.open(io.BytesIO(base64.b64decode(request['data']))) as image:
   response={'format':image.format,'size':list(image.size),'icc':bool(image.info.get('icc_profile')),'exif':dict(image.getexif()),'loop':image.info.get('loop'),'defaultImage':bool(image.info.get('default_image',False)),'frames':[],'mode':image.mode,'extrema':image.getextrema()}
   for i in range(121):
    try:image.seek(i)
    except EOFError:break
    image.load(); rgba=image.convert('RGBA')
    response['frames'].append({'size':list(image.size),'duration':image.info.get('duration'),'alpha':list(rgba.getextrema()[3]),'pixel':list(rgba.getpixel((0,0)))})
  response['frameCount']=len(response['frames'])
 else:raise RuntimeError('unknown probe')
 print(json.dumps({'ok':True,**response}))
except ImageCompressionError as error:
 print(json.dumps({'ok':False,'error':str(error)}))
`;

function call(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Image compression probe timed out.')); }, 100_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Image probe exited ${code}: ${stderr.slice(-2000)}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stdout + stderr)); } }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function fixture(kind) { const result = await call({ op: 'fixture', kind }); assert.equal(result.ok, true); return { name: `source.${kind}`, data: result.data }; }
const compress = (file, targetBytes, outputFormat = 'auto') => call({ op: 'compress', payload: { file, targetBytes, outputFormat } });
const inspect = result => call({ op: 'inspect', data: result.data });
function checkResult(result, input, target) {
  assert.equal(result.ok, true, result.error);
  assert.equal(result.inputBytes, Buffer.from(input.data, 'base64').length);
  assert.equal(result.outputBytes, Buffer.from(result.data, 'base64').length);
  assert.equal(result.targetReached, result.outputBytes <= target);
  assert.equal(result.targetBytes, target);
  assert.ok(result.attempts <= 52);
  assert.ok(result.resultMessage.length > 20);
}

test('image compression detects bytes and preserves an original already below the requested maximum', async () => {
  const file = await fixture('PNG'); file.name = 'misnamed.pdf';
  const result = await compress(file, 10000);
  checkResult(result, file, 10000);
  assert.equal(result.data, file.data);
  assert.equal(result.format, 'png');
  assert.equal(result.compressionMethod, 'original');
  assert.equal(result.metadataRemoved, false);
});

test('target image search retains full dimensions while finding a real size-bounded output', { timeout: 120_000 }, async () => {
  const file = await fixture('noise');
  const result = await compress(file, 50000);
  checkResult(result, file, 50000);
  assert.equal(result.targetReached, true);
  assert.equal(result.resized, false);
  assert.ok(result.outputBytes < result.inputBytes);
  const decoded = await inspect(result);
  assert.deepEqual(decoded.size, [320, 240]);
  assert.ok(result.quality === null || result.quality >= 50);
});

test('transparent image output preserves alpha and refuses implicit JPG flattening', { timeout: 120_000 }, async () => {
  const file = await fixture('transparent');
  const result = await compress(file, 50000, 'webp');
  checkResult(result, file, 50000);
  assert.equal(result.targetReached, true);
  const decoded = await inspect(result);
  assert.deepEqual(decoded.frames[0].alpha, [0, 255]);
  assert.equal(decoded.format, 'WEBP');
  const jpeg = await compress(file, 50000, 'jpeg');
  assert.equal(jpeg.ok, false);
  assert.match(jpeg.error, /transparency/i);
});

test('image re-encoding applies EXIF orientation and removes private EXIF while retaining color profiles', async () => {
  const oriented = await fixture('oriented');
  const result = await compress(oriented, 50000, 'png');
  checkResult(result, oriented, 50000);
  const decoded = await inspect(result);
  assert.deepEqual(decoded.size, [40, 80]);
  assert.deepEqual(decoded.exif, {});
  const profiled = await fixture('profile');
  const optimized = await compress(profiled, 1000, 'png');
  checkResult(optimized, profiled, 1000);
  assert.equal(optimized.targetReached, true);
  const profileOutput = await inspect(optimized);
  assert.equal(profileOutput.icc, true);
  assert.deepEqual(profileOutput.exif, {});
  assert.deepEqual(profileOutput.frames[0].pixel, [12, 110, 220, 255]);
});

test('animation compression preserves all frames, timing and loop; JPG conversion is rejected', { timeout: 120_000 }, async () => {
  const file = await fixture('gif');
  const result = await compress(file, 8000);
  checkResult(result, file, 8000);
  const decoded = await inspect(result);
  assert.equal(decoded.frameCount, 3);
  assert.equal(decoded.loop, 3);
  assert.deepEqual(decoded.frames.map(frame => frame.duration), [120, 230, 340]);
  const jpeg = await compress(file, 8000, 'jpeg');
  assert.equal(jpeg.ok, false);
  assert.match(jpeg.error, /animation|pages/i);
});

test('play-once GIF compression does not introduce an infinite-loop extension', { timeout: 120_000 }, async () => {
  const file = await fixture('gif-once');
  const before = await inspect(file);
  assert.equal(before.loop, null);
  const result = await compress(file, 9000);
  checkResult(result, file, 9000);
  assert.notEqual(result.data, file.data, 'Exercise a real re-encode rather than original retention.');
  const decoded = await inspect(result);
  assert.equal(decoded.format, 'GIF');
  assert.equal(decoded.loop, null);
  assert.equal(decoded.frameCount, 3);
  assert.deepEqual(decoded.frames.map(frame => frame.duration), [120, 230, 340]);
  const webp = await compress(file, 9000, 'webp');
  assert.equal(webp.ok, false);
  assert.match(webp.error, /source animation format|Cross-format animation/i);
});

test('APNG compression keeps its default poster outside the animation and retains frame timing', { timeout: 120_000 }, async () => {
  const file = await fixture('apng-poster');
  const before = await inspect(file);
  assert.equal(before.defaultImage, true);
  assert.deepEqual(before.frames.map(frame => frame.duration), [null, 200, 300]);
  const result = await compress(file, 9000);
  checkResult(result, file, 9000);
  assert.notEqual(result.data, file.data, 'Exercise a real re-encode rather than original retention.');
  const decoded = await inspect(result);
  assert.equal(decoded.format, 'PNG');
  assert.equal(decoded.defaultImage, true);
  assert.equal(decoded.loop, 2);
  assert.equal(decoded.frameCount, 3);
  assert.deepEqual(decoded.frames.map(frame => frame.duration), [null, 200, 300]);
  const webp = await compress(file, 9000, 'webp');
  assert.equal(webp.ok, false);
  assert.match(webp.error, /source animation format|Cross-format animation/i);
});

test('multipage TIFF auto compression preserves each page and rejects silent single-image conversion', async () => {
  const file = await fixture('tiff');
  const result = await compress(file, 2000);
  checkResult(result, file, 2000);
  assert.equal(result.targetReached, true);
  const decoded = await inspect(result);
  assert.equal(decoded.format, 'TIFF');
  assert.equal(decoded.frameCount, 2);
  assert.deepEqual(decoded.frames.map(frame => frame.size), [[256, 128], [192, 144]]);
  assert.deepEqual(decoded.frames.map(frame => frame.pixel), [[255, 0, 0, 255], [0, 0, 255, 255]]);
  const png = await compress(file, 2000, 'png');
  assert.equal(png.ok, false);
  assert.match(png.error, /every TIFF or HEIF page/i);
});

test('HEIC/HEIF inputs decode locally and multiple images survive in auto TIFF output', { timeout: 120_000 }, async () => {
  const file = await fixture('heif');
  const result = await compress(file, 6000, 'webp');
  checkResult(result, file, 6000);
  assert.equal((await inspect(result)).format, 'WEBP');
  const multiple = await fixture('multi-heif');
  const converted = await compress(multiple, 4000);
  checkResult(converted, multiple, 4000);
  const decoded = await inspect(converted);
  assert.equal(decoded.frameCount, 2);
  assert.equal(converted.frames, 2);
});

test('common raster formats are identified from bytes and converted to real supported image output', { timeout: 120_000 }, async () => {
  for (const kind of ['JPEG', 'PNG', 'WEBP', 'AVIF', 'BMP', 'TIFF', 'GIF', 'ICO', 'JPEG2000', 'PPM', 'TGA', 'QOI']) {
    const file = await fixture(kind);
    const result = await compress(file, 10000, 'webp');
    checkResult(result, file, 10000);
    assert.equal((await inspect(result)).format, 'WEBP', kind);
  }
});

test('an impossible multipage target is reported honestly without discarding pages or padding output', async () => {
  const file = await fixture('many-tiff');
  const result = await compress(file, 1000);
  checkResult(result, file, 1000);
  assert.equal(result.targetReached, false);
  assert.match(result.resultMessage, /could not be reached/i);
  assert.ok(result.outputBytes <= result.inputBytes);
  assert.equal((await inspect(result)).frameCount, 24);
});

test('an original retained above target reports a miss and preserves animated AVIF bytes', async () => {
  const file = await fixture('animated-avif');
  const result = await compress(file, 1000);
  checkResult(result, file, 1000);
  assert.equal(result.data, file.data);
  assert.equal(result.targetReached, false);
  assert.equal(result.compressionMethod, 'original');
  assert.equal(result.metadataRemoved, false);
  assert.match(result.resultMessage, /could not be reached/i);
  assert.doesNotMatch(result.resultMessage, /already below/i);
  assert.equal((await inspect(result)).frameCount, 2);
});

test('16-bit grayscale compression retains sample precision instead of clipping it to white', async () => {
  const file = await fixture('gray16');
  const before = await inspect(file);
  const result = await compress(file, 10000, 'png');
  checkResult(result, file, 10000);
  assert.equal(result.targetReached, true);
  const decoded = await inspect(result);
  assert.equal(decoded.mode, 'I;16');
  assert.deepEqual(decoded.extrema, before.extrema);
  assert.ok(decoded.extrema[1] > 255);
  const jpeg = await compress(file, 10000, 'jpeg');
  assert.equal(jpeg.ok, false);
  assert.match(jpeg.error, /16-bit grayscale precision/i);
});

test('48 megapixel phone photos within the upload limit are accepted and retained when already below target', { timeout: 120_000 }, async () => {
  const file = await fixture('large-photo');
  const result = await compress(file, 1000000);
  checkResult(result, file, 1000000);
  assert.equal(result.targetReached, true);
  assert.deepEqual([result.width, result.height], [8000, 6000]);
  assert.equal(result.data, file.data);
});

test('image compression validates malformed files, unsupported vectors, dimensions and strict byte targets', async () => {
  const file = await fixture('PNG');
  for (const target of [null, true, '1000', 999, 1.5, 16777217]) {
    const result = await compress(file, target);
    assert.equal(result.ok, false);
    assert.match(result.error, /target maximum/i);
  }
  for (const bad of [{ name: 'bad.png', data: '!!!!' }, { name: 'vector.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }]) {
    assert.equal((await compress(bad, 1000)).ok, false);
  }
  const wide = await compress(await fixture('too-wide'), 1000);
  assert.equal(wide.ok, false);
  assert.match(wide.error, /30000 pixels/i);
});
