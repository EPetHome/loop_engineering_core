#!/usr/bin/env python3
"""Optional TypeScript + Node host mock; NEVER a real Pi SDK/host acceptance."""
import json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
BUNDLE=Path(__file__).resolve().parents[1]
def main():
    node,tsc,npm=(shutil.which(x) for x in ('node','tsc','npm'))
    if not all((node,tsc,npm)):
        print('NOT_RUN: local node, tsc and npm are required; nothing is installed automatically');return 3
    global_modules=Path(subprocess.check_output([npm,'root','-g'],text=True).strip())
    candidates=[global_modules/'ts-node/node_modules/@types',global_modules/'@types',BUNDLE/'node_modules/@types']
    types=next((p for p in candidates if (p/'node').is_dir()),None)
    if not types:
        print('NOT_RUN: @types/node is not already available locally; no network/install attempted');return 3
    with tempfile.TemporaryDirectory(prefix='loop-ts-check-') as t:
        p=Path(t);shutil.copy2(BUNDLE/'extensions/pi/loop-member-tools.ts',p/'loop-member-tools.ts')
        for name in ('host-stubs.d.ts','test-extension.cjs'):shutil.copy2(BUNDLE/'tests040/ts'/name,p/name)
        config={'compilerOptions':{'target':'ES2022','module':'CommonJS','moduleResolution':'Node','strict':True,'skipLibCheck':True,
                                  'esModuleInterop':True,'outDir':str(p/'out'),'typeRoots':[str(types)],'types':['node']},
                'files':[str(p/'host-stubs.d.ts'),str(p/'loop-member-tools.ts')]}
        (p/'tsconfig.json').write_text(json.dumps(config))
        stub=p/'node_modules/@sinclair/typebox';stub.mkdir(parents=True)
        (stub/'index.js').write_text("exports.Type={Object:(x)=>x,String:()=>({type:'string'}),Array:(x,o)=>({type:'array',items:x,...(o||{})})};\n")
        c=subprocess.run([tsc,'--project',str(p/'tsconfig.json')],cwd=p,timeout=30)
        if c.returncode:return c.returncode
        c=subprocess.run([node,str(p/'test-extension.cjs')],cwd=p,timeout=30)
        print(json.dumps({'real_pi':False,'sdk_types':'local minimal host declarations, not Pi SDK','automatic_installs':0}))
        return c.returncode
if __name__=='__main__':raise SystemExit(main())
