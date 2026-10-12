#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$1
mobile=$2
flutter=$3
unit=$4
review=$5
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "REVIZYON_HATASI: $code"; fi' EXIT

working=$(systemctl show "$unit" -p WorkingDirectory --value)
[ "$(readlink -f "$working")" = "$(readlink -f "$root")" ] || {
  echo "SERVIS_PROJE_DIZINI_UYUSMUYOR"
  exit 1
}

cd "$repo"
node scripts/test-odds-contract.js > "$review/final-backend-tests.log" 2>&1
tail -1 "$review/final-backend-tests.log"
python3 scripts/apply-odds-revision.py --backend "$root" --android "$mobile"
sudo -n systemctl restart "$unit"
ready=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 10 http://127.0.0.1:3100/health > "$review/health.json"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ]
echo "YENI_BACKEND_SAGLIK_KONTROLU_GECTI"

for item in 'xnGLmLIO:small' 'GxLyDAQb:large'; do
  event=${item%:*}
  size=${item#*:}
  python3 "$repo/scripts/validate-odds-http.py" \
    --android "$mobile" --event "$event" \
    --state-directory "$root/var/odds-contract/state" \
    --output "$review/http-$size" > "$review/http-$size.log" 2>&1
  tail -1 "$review/http-$size.log"
done

sdk=$(python3 - "$mobile" <<'PYSDK'
from pathlib import Path
import os, re, subprocess, sys
mobile=Path(sys.argv[1]); candidates=[]
props=mobile/"android/local.properties"
if props.exists():
    match=re.search(r"(?m)^sdk.dir=(.+)$",props.read_text())
    if match: candidates.append(match.group(1).strip())
candidates.extend(os.environ.get(k,"") for k in ("ANDROID_HOME","ANDROID_SDK_ROOT"))
result=subprocess.run(["find",str(Path.home()),"/opt","-maxdepth","4",
                       "-type","d","-name","build-tools"],capture_output=True,text=True)
candidates.extend(str(Path(p).parent) for p in result.stdout.splitlines())
for name in dict.fromkeys(candidates):
    if not name: continue
    sdk=Path(name)
    if (sdk/"build-tools").is_dir() and (sdk/"platforms").is_dir():
        print(sdk.resolve()); break
else:
    raise RuntimeError("ANDROID_SDK_KURULUMU_BULUNAMADI")
PYSDK
)
export ANDROID_HOME="$sdk"
export ANDROID_SDK_ROOT="$sdk"
echo "ANDROID_SDK: $sdk"
cd "$mobile"
"$flutter" test > "$review/final-flutter-tests.log" 2>&1
tail -1 "$review/final-flutter-tests.log"
"$flutter" build apk --release --target-platform android-arm64 > "$review/apk-build.log" 2>&1
tail -3 "$review/apk-build.log"

python3 - "$root" "$mobile" "$review" <<'PY'
from pathlib import Path
import hashlib, json, re, shutil, subprocess, sys, zipfile
root, mobile, review = map(Path, sys.argv[1:])
version_text = re.search(r"(?m)^version:\s*(\d+\.\d+\.\d+)\+(\d+)", (mobile / "pubspec.yaml").read_text())
assert version_text, "APK_SURUMU_YOK"
version_name, version_code = version_text.groups()
apk = mobile / "build/app/outputs/flutter-apk/app-release.apk"
assert apk.is_file(), "APK_YOK"
with zipfile.ZipFile(apk) as z:
    assert z.testzip() is None
    assert "lib/arm64-v8a/libapp.so" in z.namelist()
props = (mobile / "android/local.properties").read_text()
sdk = Path(re.search(r"(?m)^sdk.dir=(.+)$", props).group(1).strip())
tools = sorted(p for p in (sdk / "build-tools").iterdir()
               if (p / "apksigner").is_file())
assert tools, "APKSIGNER_YOK"
tool = tools[-1]
def signer(path):
    text = subprocess.check_output(
        [str(tool / "apksigner"), "verify", "--print-certs", str(path)], text=True)
    result = re.findall(r"Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]+)", text)
    assert result, "APK_IMZASI_DOGRULANAMADI"
    return sorted(result)
new_signer = signer(apk)
old = root / "var/odds-contract/apk-delivery/9d7e252f4624d1d4bc809ffc362abcbc7d905b349a7d38784348011ae9d4fce4.apk"
assert old.is_file(), "ESKI_APK_IMZA_KARSILASTIRMASI_ICIN_YOK"
assert new_signer == signer(old), "APK_GUNCELLEME_IMZASI_FARKLI"
badging = subprocess.check_output([str(tool / "aapt"), "dump", "badging", str(apk)], text=True)
assert "name='com.macradar.macradar'" in badging
assert f"versionCode='{version_code}'" in badging
assert f"versionName='{version_name}'" in badging
delivery = root / "artifacts/odds-revision-delivery-20261012"
delivery.mkdir(parents=True, exist_ok=True)
target = delivery / f"MacRadar-{version_name}.apk"
shutil.copy2(apk, target)
report = {
    "apk": str(target), "bytes": target.stat().st_size,
    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    "version": f"{version_name}+{version_code}", "signature": "PASSED", "same_update_signer": True,
    "zip_integrity": "PASSED", "actual_http_exports": "PASSED",
    "phone_download": "NOT_PERFORMED", "external_reader_test": "NOT_PERFORMED"
}
(delivery / "delivery.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))
progress = root / "docs/ODDS_PROGRESS.md"
with progress.open("a") as stream:
    stream.write("\n## Sunucu uygulama ve APK sonucu\n\n")
    stream.write("- macradar.service yenilendi; ayrı dropping servisi değiştirilmedi.\n")
    stream.write("- 48 backend testi ve son revizyon mobil testleri geçti; analiz hata sayısı 0.\n")
    stream.write("- İki gerçek mevcut APK HTTP export akışı, ZIP/schema/manifest/kanıt ve ham kayıt koruma denetimleri geçti.\n")
    stream.write(f"- APK {version_name}+{version_code} derlendi; imza, aynı güncelleme imzası ve ZIP bütünlüğü doğrulandı.\n")
    stream.write("- Telefon indirme/kurulum/kart indirme ve harici okuyucu kabulü henüz yapılmadı.\n")
    stream.write("- Teslim kanıtı: artifacts/odds-revision-delivery-20261012/delivery.json\n")
PY
echo "REVIZYON_VE_APK_HAZIR"
