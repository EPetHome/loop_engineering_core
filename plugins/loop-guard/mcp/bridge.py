#!/usr/bin/env python3
"""Dependency-free MCP stdio bridge, newline JSON-RPC. No server auto-start.

Only preparation methods; no arbitrary proxy, approvals, launch or shell.
MCP logging goes to stderr, never stdout. Socket address is owner configuration.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import sys

FIELDS={
 'loop_prepare_begin': {'project_id':'string'},
 'loop_prepare_patch': {'prep_id':'string','revision':'integer','changes':'object'},
 'loop_prepare_check': {'prep_id':'string','revision':'integer'},
 'loop_prepare_probe': {'prep_id':'string','revision':'integer','question_id':'string'},
 'loop_prepare_seal': {'prep_id':'string','revision':'integer'},
 'loop_prepare_status': {'prep_id':'string'},
 'loop_project_info': {'project_id':'string'},
 'loop_project_list': {'project_id':'string','path':'string'},
 'loop_project_read': {'project_id':'string','path':'string','start_line':'integer','max_lines':'integer'},
}
DESCRIPTIONS={
 'loop_prepare_begin':'创建草稿，不执行模型/业务。项目必须由用户预先登记。',
 'loop_prepare_patch':'替换本次业务字段，程序生成配置关联；不能改固定接法/授权范围。',
 'loop_prepare_check':'一次汇总已知阻断项；相同revision缓存。READY不是业务通过。',
 'loop_prepare_probe':'仅针对已登记未决question执行有预算的探测；不接受argv。',
 'loop_prepare_seal':'封存并给用户启动命令；不会替用户启动或批准。',
 'loop_prepare_status':'查看草稿与剩余问题，不触发新探测。',
 'loop_project_info':'读取已经人工登记的能力和配置。',
 'loop_project_list':'项目内有界目录列表；不跟随链接。',
 'loop_project_read':'项目内文本分页读取；不提供任意Shell。',
}
MAX_FRAME=2*1024*1024
# Same default for both hosts; LOOP_GUARD_CONFIG overrides it (tests, custom installs).
DEFAULT_CONFIG=Path.home()/'.loop040'/'runtime.json'


def load_config():
    path=Path(os.environ.get('LOOP_GUARD_CONFIG') or DEFAULT_CONFIG)
    try:
        config=json.loads(path.read_text())
    except (OSError,ValueError) as exc:
        raise ValueError('Loop Guard 准备服务未配置（%s）。请用户在终端运行 loop_guard.py plugin-config 与 serve；'
                         '不要自己代替用户启动或改配置。' % path) from exc
    if not isinstance(config,dict) or not isinstance(config.get('socket'),str):
        raise ValueError('Loop Guard runtime 配置缺少 socket：%s' % path)
    return config


def tools():
    out=[]
    for name, fields in FIELDS.items():
        out.append({'name':name,'description':DESCRIPTIONS[name],
                    'inputSchema':{'type':'object','properties':{k:{'type':v} for k,v in fields.items()},
                                   'required':list(fields),'additionalProperties':False}})
    return out


def invoke(name,args,config):
    if name not in FIELDS or not isinstance(args,dict) or set(args)!=set(FIELDS[name]):
        raise ValueError('unknown capability or invalid arguments')
    for key,kind in FIELDS[name].items():
        types={'string':str,'integer':int,'object':dict}
        if type(args[key]) is not types[kind]:
            raise ValueError('invalid argument type: '+key)
    body=json.dumps({'method':name,'args':args},ensure_ascii=False).encode()+b'\n'
    if len(body)>MAX_FRAME: raise ValueError('request too large')
    config=config or load_config()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
        s.settimeout(180)
        try:
            s.connect(config['socket'])
        except OSError as exc:
            raise ValueError('Loop Guard 准备服务没有运行（%s）。请用户在终端启动 loop_guard.py serve。' % config['socket']) from exc
        s.sendall(body)
        with s.makefile('rb') as f: raw=f.readline(MAX_FRAME+1)
    if len(raw)>MAX_FRAME or not raw.endswith(b'\n'): raise ValueError('invalid response')
    response=json.loads(raw)
    if not response.get('ok'): raise ValueError(response.get('error','controller refused'))
    return response['result']


def handle(request,config):
    if not isinstance(request,dict) or request.get('jsonrpc')!='2.0':
        raise ValueError('invalid JSON-RPC envelope')
    if 'id' not in request:
        return None
    rid,method,params=request['id'],request.get('method'),request.get('params',{})
    if method=='initialize':
        offered=params.get('protocolVersion','2024-11-05')
        version=offered if offered in ('2024-11-05','2025-03-26','2025-06-18') else '2024-11-05'
        result={'protocolVersion':version,'capabilities':{'tools':{'listChanged':False}},
                'serverInfo':{'name':'loop-guard','version':'0.4.0'}}
    elif method=='ping': result={}
    elif method=='tools/list': result={'tools':tools()}
    elif method=='tools/call':
        try:
            value=invoke(params.get('name'),params.get('arguments',{}),config)
            result={'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}],'isError':False}
        except Exception as exc:
            result={'content':[{'type':'text','text':str(exc)}],'isError':True}
    else:
        return {'jsonrpc':'2.0','id':rid,'error':{'code':-32601,'message':'method not found'}}
    return {'jsonrpc':'2.0','id':rid,'result':result}


def main():
    # Config is read per call: a missing service is a tool error, not a failed MCP start.
    config=None
    while True:
        raw=sys.stdin.buffer.readline(MAX_FRAME+1)
        if not raw: return 0
        if len(raw)>MAX_FRAME or not raw.endswith(b'\n'):
            print('MCP frame too large',file=sys.stderr); return 2
        try:
            response=handle(json.loads(raw),config)
        except Exception as exc:
            response={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':str(exc)}}
        if response is not None:
            sys.stdout.write(json.dumps(response,ensure_ascii=False)+'\n'); sys.stdout.flush()

if __name__=='__main__':
    raise SystemExit(main())
