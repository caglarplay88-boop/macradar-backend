#!/usr/bin/env python3
import datetime,getpass,json,os,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parents[1]
event='GxLyDAQb'
base=os.environ.get('MACRADAR_AUDIT_BASE_URL','http://127.0.0.1:3100').rstrip('/')
key=os.environ.get('MACRADAR_AUDIT_API_KEY') or getpass.getpass('MacRadar uygulama giriş kodu (gizli): ')
def fetch(route):
 req=urllib.request.Request(base+route,headers={'x-api-key':key})
 with urllib.request.urlopen(req,timeout=30) as response: return json.load(response)
try:
 result={'eventId':event,'exportedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'authenticated_running_backend_api','availabilityVerifiedAtHistoricalCutoff':False,'match':fetch('/api/matches/'+event),'markets':{}}
 for market in ['1x2','over-under','asian','kg']:
  rows=[];page=1;expected=None
  while True:
   data=fetch('/api/matches/'+event+'/odds/'+market+'/history?page='+str(page))
   total=int(data['total_records'])
   if expected is None: expected=total
   if total!=expected: raise ValueError('Veri çekilirken kayıt sayısı değişti; yeniden çalıştır.')
   rows.extend(data['rows'])
   if not data.get('has_next'): break
   page+=1
   if page>10000: raise ValueError('Sayfa sınırı aşıldı; veri kesilmedi.')
  if len(rows)!=expected or len({str(row['id']) for row in rows})!=len(rows): raise ValueError(market+' geçmişi eksik veya tekrarlı.')
  result['markets'][market]={'totalRecords':expected,'pagesRead':page,'rows':rows}
  print(market.upper()+': '+str(expected)+' kayıt, '+str(len({r['bookmaker_key'] for r in rows}))+' bookmaker')
 try: result['performance']=fetch('/api/matches/'+event+'/performance')
 except urllib.error.HTTPError as e: result['performance']={'available':False,'httpStatus':e.code}
 out=root/'artifacts'/'real_match_audit'/'GxLyDAQb-full-export.json'
 out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 print('GERCEK_MAC_VERISI_KAYDEDILDI')
except urllib.error.HTTPError as e:
 print('ERISIM_HATASI: HTTP '+str(e.code));raise SystemExit(1)
except Exception as e:
 print('KONTROL_HATASI: '+str(e));raise SystemExit(1)
