"""Reuse iteration 02's unchanged release checks for the approved 0.3.0 target."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT/'engine'
sys.path.insert(0,str(ENGINE/'acceptance'))
spec=importlib.util.spec_from_file_location('release_checks',ENGINE/'acceptance/check_release.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.VERSION='0.3.0'
result=module.main()
if result:raise SystemExit(result)
# External adapter / entry changes must be present in the one composed delivery.
required=['run_loop.py','adapters/pi_member.py','prompts/brief.md','docs/本机验证与会话对照.md']
for name in required:
    if not (ROOT/name).is_file():raise SystemExit('缺少集成交付文件：'+name)
if '/Users/Admin/Desktop/Promate/' in (ROOT/'run_loop.py').read_text():
    raise SystemExit('简报提示仍依赖项目外的Promate文件；本次应使用交付内prompts/brief.md')
print('0.3.0 版本、指纹及组合交付检查通过；真实会话收益仍须另行对照。')
