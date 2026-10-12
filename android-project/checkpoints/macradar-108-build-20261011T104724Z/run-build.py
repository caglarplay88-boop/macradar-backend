
from pathlib import Path
import subprocess,os,json,hashlib,shutil
root=Path("/home/ubuntu/macradar-mobile-src")
folder=Path(__file__).parent
env=os.environ.copy()
env["ANDROID_HOME"]="/home/ubuntu/android-sdk"
env["ANDROID_SDK_ROOT"]="/home/ubuntu/android-sdk"
env["PATH"]="/home/ubuntu/develop/flutter/bin:"+env.get("PATH","")
flutter="/home/ubuntu/develop/flutter/bin/flutter"
with (folder/"analyze.log").open("w") as log:
    check=subprocess.run([flutter,"analyze","--no-fatal-infos","--no-fatal-warnings"],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
(folder/"analyze-exit.txt").write_text(str(check.returncode))
if check.returncode:
    (folder/"exit-code.txt").write_text(str(check.returncode))
    raise SystemExit(check.returncode)
with (folder/"build.log").open("w") as log:
    build=subprocess.run([flutter,"build","apk","--release","--build-name=1.0.8","--build-number=108"],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
if build.returncode==0:
    source=root/"build/app/outputs/flutter-apk/app-release.apk"
    apk=folder/"MacRadar-1.0.8-108.apk"
    shutil.copy2(source,apk)
    info={"path":str(apk),"bytes":apk.stat().st_size,"sha256":hashlib.sha256(apk.read_bytes()).hexdigest(),"version":"1.0.8","versionCode":108}
    (folder/"apk-ready.json").write_text(json.dumps(info,indent=2))
(folder/"exit-code.txt").write_text(str(build.returncode))
