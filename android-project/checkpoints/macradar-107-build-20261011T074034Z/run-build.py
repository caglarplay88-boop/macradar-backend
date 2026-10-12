
import os, subprocess, json, hashlib, shutil
from pathlib import Path
root=Path('/home/ubuntu/macradar-mobile-src')
folder=Path(__file__).parent
env=os.environ.copy()
env['ANDROID_HOME']='/home/ubuntu/android-sdk'
env['ANDROID_SDK_ROOT']='/home/ubuntu/android-sdk'
env['PATH']='/home/ubuntu/develop/flutter/bin:'+env.get('PATH','')
with (folder/'build.log').open('w') as log:
    result=subprocess.run([
        '/home/ubuntu/develop/flutter/bin/flutter',
        'build','apk','--release','--no-pub'
    ],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
(folder/'exit-code.txt').write_text(str(result.returncode))
if result.returncode==0:
    source=root/'build/app/outputs/flutter-apk/app-release.apk'
    target=folder/'MacRadar-1.0.7-107.apk'
    shutil.copy2(source,target)
    data=target.read_bytes()
    (folder/'apk-ready.json').write_text(json.dumps({
        'path':str(target),'bytes':len(data),
        'sha256':hashlib.sha256(data).hexdigest(),
        'version':'1.0.7','versionCode':107
    },indent=2))
