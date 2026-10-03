'use strict';
// Standalone Node host/transport mock: does not claim real Pi registration.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path'); const net = require('node:net');
const extension = require('./out/loop-member-tools.js').default;
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'loop-ts-'));
 const code=path.join(root,'code');fs.mkdirSync(code);fs.mkdirSync(path.join(code,'src'));
 fs.writeFileSync(path.join(code,'src','a'),'a');fs.symlinkSync(root,path.join(code,'escape'));
 const socket=path.join(root,'rpc.sock'); const requests=[];let hold=null;
 const server=net.createServer(c=>{c.setEncoding('utf8');let body='';c.on('data',chunk=>{body+=chunk;if(!body.includes('\n'))return;
  const req=JSON.parse(body.split('\n')[0]);requests.push(req);assert.equal(req.token,'nonce');
  const send=()=>{const b=Buffer.from(JSON.stringify({ok:true,result:{status:'PASS',purpose:'SELF_TEST',text:'中文返回'}})+'\n');
   // Intentionally split inside UTF-8 codepoint.
   const i=b.indexOf(Buffer.from('中'))+1;c.write(b.subarray(0,i));setTimeout(()=>c.end(b.subarray(i)),5);};
  if(req.method==='build'&&req.request_id==='hold')hold=send;else send();
 });});
 await new Promise(r=>server.listen(socket,r));
 const ctx={role:'developer',managed_tools:true,code_path:code,unit:{stage_timeout_seconds:2,writable_paths:['src/'],protected_paths:['src/locked'],build_profiles:['p']},execution_profiles:{p:{output_paths:['src/target/']}}};
 const cf=path.join(root,'context.json');process.env.LOOP_CONTEXT=cf;process.env.LOOP_MEMBER_SOCKET=socket;process.env.LOOP_MEMBER_TOKEN='nonce';
 function load(c){fs.writeFileSync(cf,JSON.stringify(c));const tools={},events={};let active=[];extension({registerTool(t){tools[t.name]=t;},on(n,f){events[n]=f;},setActiveTools(a){active=a;}});return{tools,events,get active(){return active;}};}
 let host=load(ctx);await host.events.session_start();assert.equal(requests[0].method,'hello');
 assert(host.active.includes('loop_build'));assert(!host.active.includes('bash'));
 assert.equal((await host.events.tool_call({toolName:'bash',input:{command:'python evil.py'}})).block,true);
 for(const p of ['../outside','src/locked','src/target/out','escape/out'])assert.equal((await host.events.tool_call({toolName:'write',input:{path:p}})).block,true,p);
 assert.equal(await host.events.tool_call({toolName:'write',input:{path:'src/ok'}}),undefined);
 const result=await host.tools.loop_build.execute('call-1',{recipe_id:'p'});assert.equal(result.details.text,'中文返回');
 assert.equal(requests.at(-1).recipe_id,'p');
 const pending=host.tools.loop_build.execute('hold',{recipe_id:'p'});while(!hold)await new Promise(r=>setTimeout(r,1));
 assert.equal((await host.events.tool_call({toolName:'edit',input:{path:'src/a'}})).block,true);hold();await pending;
 assert.equal((await host.events.cache_warming_decision()).action,'stop');
 host=load({...ctx,role:'reviewer'});await host.events.session_start();assert(!host.active.includes('loop_build'));assert(!host.active.includes('write'));
 await assert.rejects(()=>host.tools.loop_build.execute('no',{recipe_id:'p'}),/not allowed/);
 const ac=new AbortController();ac.abort();await assert.rejects(()=>host.tools.loop_submit_check.execute('s',{},ac.signal),/cancelled/);
 await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
 console.log(JSON.stringify({test:'Pi extension standalone host/transport mock',assertions:'registration, hello, read-only tools, paths, active-build lock, fragmented UTF-8, abort, cache-warming disabled',result:'PASS',real_pi:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
