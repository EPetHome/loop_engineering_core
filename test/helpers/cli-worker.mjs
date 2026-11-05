/** 私有测试进程：真实CLI调度，不替换Git、方法、队列或检查结果。 */
import {readFileSync, renameSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {main} from '../../loop.ts';
const dir=process.argv[2], request=join(dir,'request.json'), response=join(dir,'response.json');
const capture=chunks=>(chunk,encoding,callback)=>{chunks.push(String(chunk));if(typeof encoding==='function')encoding();else callback?.();return true;};
// 由IPC唤醒，不在空闲时反复扫描文件；父测试退出也不会留下空转进程。
process.once('disconnect',()=>process.exit(0));
let busy=false;
process.on('message',async message=>{
  if(busy)return;
  busy=true;
  const call=JSON.parse(readFileSync(request,'utf8')); rmSync(request);
  if(call.id!==message.id)throw new Error('CLI请求身份不符');
  const reply=value=>{const temp=response+'.tmp';writeFileSync(temp,JSON.stringify({id:call.id,...value}),{mode:0o600});renameSync(temp,response);};
  if(call.stop){reply({status:0,stdout:'',stderr:''});process.disconnect();return;}
  for(const key of Object.keys(process.env))if(!(key in call.env))delete process.env[key];
  Object.assign(process.env,call.env);
  const stdout=[],stderr=[],out=process.stdout.write,err=process.stderr.write;
  let status;
  try {process.stdout.write=capture(stdout);process.stderr.write=capture(stderr);status=await main(call.args);}
  catch(error){status=1;stderr.push(String(error?.stack??error));}
  finally{process.stdout.write=out;process.stderr.write=err;}
  reply({status,stdout:stdout.join(''),stderr:stderr.join('')});
  busy=false;
});
