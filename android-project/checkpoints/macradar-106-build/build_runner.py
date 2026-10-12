
from pathlib import Path
import os,subprocess,json,hashlib,shutil,traceback
root=Path('/home/ubuntu/macradar-mobile-src')
folder=root/'checkpoints/macradar-106-build'
env=os.environ.copy()
env['PATH']='/home/ubuntu/develop/flutter/bin:'+env.get('PATH','')
env['ANDROID_HOME']='/home/ubuntu/android-sdk'
env['ANDROID_SDK_ROOT']='/home/ubuntu/android-sdk'
code=1
with (folder/'build.log').open('w') as log:
    try:
        result=subprocess.run([
          '/home/ubuntu/develop/flutter/bin/flutter','build','apk','--release',
          '--build-name=1.0.6','--build-number=106'
        ],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError('Flutter build exit: '+str(result.returncode))
        apk=root/'build/app/outputs/flutter-apk/app-release.apk'
        if not apk.exists() or apk.stat().st_size<1000000:
            raise RuntimeError('APK artifact missing or invalid')
        result=subprocess.run(['/usr/bin/aapt','dump','badging',str(apk)],
                              capture_output=True,text=True,check=True)
        package=next(line for line in result.stdout.splitlines()
                     if line.startswith('package:'))
        if ("name='com.macradar.macradar'" not in package or
            "versionCode='106'" not in package or
            "versionName='1.0.6'" not in package):
            raise RuntimeError('APK identity mismatch: '+package)
        target=folder/'MacRadar-1.0.6-106.apk'
        shutil.copy2(apk,target)
        digest=hashlib.sha256(target.read_bytes()).hexdigest()
        meta={'path':str(target),'bytes':target.stat().st_size,
              'sha256':digest,'package':package}
        (folder/'apk-ready.json').write_text(json.dumps(meta))
        (folder/'apk-sha256.txt').write_text(digest+'\n')
        log.write('\nAPK_106_KIMLIK_VE_SHA256_KONTROLU: GECTI\n')
        code=0
    except Exception:
        traceback.print_exc(file=log)
(folder/'exit-code.txt').write_text(str(code)+'\n')
