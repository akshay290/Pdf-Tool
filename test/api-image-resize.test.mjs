import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createServer } from '../server.mjs';

function crc32(bytes) {
  let value=0xffffffff;
  for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return (value^0xffffffff)>>>0;
}

function sourcePng(width=80,height=40) {
  const chunk=(name,data)=>{const type=Buffer.from(name),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(height*(width*3+1)); let state=47;
  for(let y=0;y<height;y++)for(let x=0;x<width*3;x++){state=(Math.imul(state,1664525)+1013904223)>>>0;pixels[y*(width*3+1)+1+x]=state>>>24;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

async function api(t) {
  const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const file={name:'source.png',data:sourcePng().toString('base64')};
  return {file,post:(payload,route='resize-image')=>fetch(`http://127.0.0.1:${server.address().port}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file,...payload})})};
}

function pngSize(bytes) {
  assert.equal(bytes.toString('ascii',1,4),'PNG');
  return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
}

test('resize API fits the aspect ratio inside pixel bounds and omits target claims when compression is off',{timeout:30_000},async t=>{
  const {post}=await api(t);
  const response=await post({width:300,height:300,unit:'px',maintainAspectRatio:true,outputFormat:'png'});
  assert.equal(response.status,200,response.status===200?'':await response.text());
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.deepEqual(pngSize(bytes),[300,150]);
  assert.match(response.headers.get('content-disposition'),/localfold-resized\.png/);
  assert.equal(response.headers.get('x-image-width'),'300');
  assert.equal(response.headers.get('x-image-height'),'150');
  assert.equal(response.headers.get('x-target-bytes'),null);
  assert.equal(response.headers.get('x-target-reached'),null);
  assert.equal(Number(response.headers.get('x-output-bytes')),bytes.length);
});

test('resize API converts centimetres using DPI and reaches a feasible target without changing the requested dimensions',{timeout:60_000},async t=>{
  const {post}=await api(t);
  const response=await post({width:5.08,height:2.54,unit:'cm',dpi:300,maintainAspectRatio:false,outputFormat:'png',targetBytes:500000});
  assert.equal(response.status,200,response.status===200?'':await response.text());
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.deepEqual(pngSize(bytes),[600,300]);
  assert.equal(response.headers.get('x-image-dpi'),'300');
  assert.equal(response.headers.get('x-image-dpi-embedded'),'true');
  assert.equal(response.headers.get('x-target-reached'),'true');
  assert.equal(response.headers.get('x-target-bytes'),'500000');
  assert.ok(bytes.length<=500000);
});

test('resize API reports an impossible size honestly while keeping exact output pixels',{timeout:60_000},async t=>{
  const {post}=await api(t);
  const response=await post({width:240,height:160,unit:'px',maintainAspectRatio:false,outputFormat:'png',targetBytes:1000});
  assert.equal(response.status,200,response.status===200?'':await response.text());
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.deepEqual(pngSize(bytes),[240,160]);
  assert.equal(response.headers.get('x-target-reached'),'false');
  assert.ok(bytes.length>1000);
  assert.equal(Number(response.headers.get('x-output-bytes')),bytes.length);
});

test('resize API rejects invalid dimensions and its addition preserves the existing image compressor',{timeout:60_000},async t=>{
  const {post,file}=await api(t);
  for(const invalid of [{width:true},{width:0},{height:-1},{width:80.5},{unit:'inch'},{dpi:0},{maintainAspectRatio:'yes'},{targetBytes:true},{targetBytes:999},{unit:'cm',width:.00001,height:.00001}]){
    const response=await post({width:80,height:40,unit:'px',maintainAspectRatio:false,...invalid});
    assert.equal(response.status,400,JSON.stringify(invalid));
    assert.equal(response.headers.get('x-image-width'),null);
    assert.equal(typeof (await response.json()).error,'string');
  }
  const response=await post({targetBytes:500000,outputFormat:'auto'},'compress-image');
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(file.data,'base64'));
  assert.equal(response.headers.get('x-compression-method'),'original');
});
