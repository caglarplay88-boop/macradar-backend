
import subprocess
from pathlib import Path
folder = Path(__file__).parent
root = Path('/home/ubuntu/macradar-mobile-src')
with (folder / 'flutter-analyze.log').open('w') as log:
    result = subprocess.run([
        '/home/ubuntu/develop/flutter/bin/flutter',
        'analyze', '--no-pub', 'lib/main.dart', 'lib/match_export_panel.dart'
    ], cwd=root, stdout=log, stderr=subprocess.STDOUT)
(folder / 'flutter-analyze-exit.txt').write_text(str(result.returncode))
