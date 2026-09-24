"""PTY regression: the real CLI + a local protocol stub.
It verifies interaction; it doesn't pose as a real model evaluation.
Only generated workspaces are pretrusted; otherwise startup trust review consumes the
scripted provider replies before the terminal scenarios can begin."""
import re, os, pty, subprocess, threading, http.server, json, tempfile, pathlib, select, time, fcntl, termios, struct, sys, signal
root = pathlib.Path(__file__).resolve().parents[1]
bun = os.environ.get('BUN', 'bun')
command = [os.environ['ALFA_BINARY']] if os.environ.get('ALFA_BINARY') else [bun, str(root/'src/cli/main.ts')]
work = pathlib.Path(tempfile.mkdtemp(prefix='alfa-terminal-'))
(work/'repo').mkdir()
(work/'repo'/'value.ts').write_text('export const value = 1\n')
(work/'repo'/'.env').write_text('TEST_FIXTURE=not-a-secret\n')
(work/'outside').mkdir()
(work/'outside'/'fixture.txt').write_text('full-trust-fixture-only')
(work/'repo'/'tsconfig.json').write_text('{}')
checker=work/'repo'/'node_modules'/'.bin'/'tsc'
checker.parent.mkdir(parents=True)
checker.write_text('#!/bin/sh\nexit 0\n')
checker.chmod(0o755)
class Handler(http.server.BaseHTTPRequestHandler):
    started_agents=False
    discovery_enabled=False
    discoveries=0
    requests=[]
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path.endswith('/models') and Handler.discovery_enabled:
            Handler.discoveries+=1
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps({'data':[{'id':'new-a'},{'id':'new-b'}]}).encode())
        else:
            self.send_response(404);self.end_headers()
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Handler.requests.append(body)
        messages=body.get('messages',[])
        user=next((m.get('content','') for m in reversed(messages) if m['role']=='user'), '')
        text=user if isinstance(user,str) else str(user)
        if 'longwait' in text: time.sleep(3)
        tools=[m for m in messages if m['role']=='tool']
        delta={'content':'接続成功。日本語と中文を表示できます。'}
        finish='stop'
        if '修改' in text:
            if not tools: tool='read'; args={'filePath':str(work/'repo/value.ts')}
            elif len(tools)==1: tool='edit'; args={'filePath':str(work/'repo/value.ts'),'oldString':'value = 1','newString':'value = 2'}
            else: tool=None
            if tool:
                delta={'tool_calls':[{'index':0,'id':'call'+str(len(tools)),'type':'function','function':{'name':tool,'arguments':json.dumps(args)}}]};finish='tool_calls'
            else:delta={'content':'修改完成，value 已变成 2。'}
        if 'trust-fixture-request' in text:
            if not any(m.get('tool_call_id','').startswith('trust-fixture-') for m in tools):
                calls=[('read',{'filePath':str(work/'outside/fixture.txt')}),('bash',{'command':'printf "%s" "$ALFA_TRUST_FIXTURE_TOKEN"'})]
                delta={'tool_calls':[{'index':i,'id':f'trust-fixture-{i}','type':'function','function':{'name':name,'arguments':json.dumps(args)}} for i,(name,args) in enumerate(calls)]};finish='tool_calls'
            else: delta={'content':'full-trust-fixture complete'};finish='stop'
        if 'permission-child' in text and not any(t.get('function',{}).get('name')=='task' for t in body.get('tools',[])):
            if not tools:
                delta={'tool_calls':[{'index':i,'id':f'read-{i}','type':'function','function':{'name':'read','arguments':json.dumps({'filePath':str(work/'repo/.env')})}} for i in range(4)]};finish='tool_calls'
            else: delta={'content':'permission-child complete'};finish='stop'
        elif 'permission-parent' in text:
            if not Handler.started_agents:
                Handler.started_agents=True
                delta={'tool_calls':[{'index':i,'id':f'task-{i}','type':'function','function':{'name':'task','arguments':json.dumps({'name':f'check-{i}','prompt':'permission-child: read the test fixture'})}} for i in range(5)]};finish='tool_calls'
            else: delta={'content':'Parent progress while children work.'};finish='stop'
        if 'draft-permission-request' in text:
            if not any(m.get('tool_call_id')=='draft-probe' for m in tools):
                time.sleep(0.7)
                delta={'tool_calls':[{'index':0,'id':'draft-probe','type':'function','function':{'name':'bash','arguments':json.dumps({'command':'echo approval-draft-marker'})}}]};finish='tool_calls'
            else:delta={'content':'draft-permission complete'};finish='stop'
        if any('You score one operation' in str(m.get('content','')) for m in messages if m['role']=='system'):
            delta={'content':json.dumps({'intent':3,'harm':0,'reach':0,'leak':0})};finish='stop'
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        chunks=[{'id':'smoke','object':'chat.completion.chunk','created':1,'model':'mock','choices':[{'index':0,'delta':delta,'finish_reason':None}]}, {'id':'smoke','object':'chat.completion.chunk','created':1,'model':'mock','choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':20,'completion_tokens':10,'total_tokens':30,'prompt_tokens_details':{'cached_tokens':10,'cache_write_tokens':0}}}]
        try:
            for chunk in chunks:self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        except BrokenPipeError:pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}/v1'
config=work/'config/alfa';config.mkdir(parents=True)
(config/'config.json').write_text(json.dumps({'model':'mock/mock','sandbox':True,'check':False,'providers':{'mock':{'type':'openai-chat','baseURL':base,'noKey':True,'models':{'mock':{}}}},'language':{'interface':'en'},'permission':'default','folders':{str(work/'repo'):{'trust':'trusted','seenAt':'2026-01-01'}}}))
env={**os.environ,'XDG_CONFIG_HOME':str(work/'config'),'XDG_DATA_HOME':str(work/'data'),'ALFA_NO_UPDATE':'1','TERM':'xterm-256color','ALFA_TRUST_FIXTURE_TOKEN':'inherited-fixture-only'}
# Remove inherited model overrides; this fixture must never call an external endpoint.
for key in list(env):
    if key in ('ALFA_MODEL','APCODE_MODEL') or key.startswith(('ALFA_KEY_','ALFA_BASE_URL_')):env.pop(key)
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',20,40,0,0))
proc=subprocess.Popen(command+['-c',str(work/'repo'),'--no-color'],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True)
os.close(slave);capture=bytearray()
def wait_for(needle, timeout=12):
    start=len(capture);deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if needle.encode() in capture[start:]:return
        if select.select([master],[],[],0.1)[0]:
            try:capture.extend(os.read(master,65536))
            except OSError:break
    raise AssertionError(f'Missing {needle!r}: '+capture[-3000:].decode(errors='replace'))
def send(text):os.write(master,text.encode())
def resize(columns, rows=20):
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
    # Popen owns a new session but no controlling terminal, so deliver WINCH explicitly.
    proc.send_signal(signal.SIGWINCH)
    wait_for('\x1b[H\x1b[2J')
try:
    wait_for('OS sandbox:')
    send('resize中文draft');wait_for('resize中文draft')
    for columns in (120,40,100):resize(columns)
    send('!');wait_for('resize中文draft!')
    send('\x0c');wait_for('\x1b[2J')
    send('?');wait_for('resize中文draft!?')
    send('\x15')
    send('/sandbox off\r');wait_for('OS sandbox: off')
    assert json.loads((config/'config.json').read_text())['sandbox'] is False
    send('/sandbox on\r');wait_for('OS sandbox: on')
    assert json.loads((config/'config.json').read_text())['sandbox'] is True
    send('/settings\r');wait_for('Settings')
    resize(40)
    send('window\r');wait_for('Context tokens')
    send('256000\r');wait_for('Maximum output tokens')
    send('64000\r');wait_for('Saved; active immediately.')
    send('\x1b');time.sleep(0.2)
    assert json.loads((config/'config.json').read_text())['providers']['mock']['models']['mock']['limit']['context']==256000
    send('/context\r');wait_for('256')
    send('修改文件\r');wait_for('value = 2')
    wait_for('修改完成')
    assert Handler.requests[-1].get('max_tokens',Handler.requests[-1].get('max_completion_tokens'))==64000, 'active output limit was not applied to request'
    send('/context\r');wait_for('/cache-hit')
    cache_start=len(capture)
    send('/cache-hit\r');wait_for('Details: /debugger')
    assert b'Structural metrics' not in capture[cache_start:]
    assert b'Cache diagnostics' not in capture[cache_start:]
    cache_output=capture[cache_start:].decode(errors='replace')
    assert re.search(r'Maximum cache hit rate\s+~[0-9]',cache_output), cache_output
    assert re.search(r'Cache hit efficiency\s+~[0-9]',cache_output), cache_output
    send('/debugger\r');wait_for('Debugger')
    send('cache\r');wait_for('Cache diagnostics')
    resize(80)
    send('overview\r');wait_for('Structural metrics')
    send('requests\r');wait_for('Cache requests')
    send('1\r');wait_for('sdkObservedCache')
    send('back\r');wait_for('Cache diagnostics')
    send('back\r');wait_for('Debugger')
    send('back\r');wait_for('ctx')
    send('/detail\r');wait_for('callID')
    # Discover multiple models without re-entering a provider or switching this session.
    Handler.discovery_enabled=True
    requests_before=len(Handler.requests)
    send('/settings\r');wait_for('Settings')
    send('model\r');wait_for('Choose a model')
    send('add-model\r');wait_for('Add models from provider')
    send('mock\r');wait_for('Choose a model to add')
    send('model:new-a\r');wait_for('Save without switching')
    send('another\r');wait_for('Choose a model to add')
    send('model:new-b\r');wait_for('Save without switching')
    send('save\r');wait_for('Settings')
    Handler.discovery_enabled=False
    saved_models=json.loads((config/'config.json').read_text())
    assert {'mock','new-a','new-b'} <= set(saved_models['providers']['mock']['models'])
    assert saved_models['model']=='mock/mock'
    assert len(Handler.requests)==requests_before and Handler.discoveries==1
    send('\x1b');time.sleep(0.2)
    send('hello\r');wait_for('接続成功')
    assert Handler.requests[-1]['model']=='mock', 'save-only must not switch the active model'
    send('/');wait_for('Directory access grants')
    send('sett\t\r');wait_for('Settings')
    send('providers\r');wait_for('Manage connections')
    send('add\r');wait_for('Provider template')
    for text,needle in [('custom','Connection name'),('local2','API protocol'),('openai-chat','API base URL'),(base,'Local authentication'),('none','Model ID'),('mock','Context window tokens'),('','Ready to connect?'),('test','Connected successfully')]:
        send(text+'\r');wait_for(needle)
    send('switch\r');wait_for('Active model: local2/mock')
    send('\x1b');time.sleep(0.2)
    send('/permission confirm\r');wait_for('confirm')
    send('/settings\r');wait_for('Settings')
    send('check\r');wait_for('Run now')
    send('on\r');wait_for('Settings')
    send('check\r');wait_for('Run now')
    send('run\r');wait_for('Approve · bash')
    send('\r');wait_for('tsc passed');wait_for('Settings')
    send('\x1b');time.sleep(0.2)
    send('/check off\r');wait_for('off')
    send('draft-permission-request\r')
    time.sleep(0.15)
    send('keep-my-draft')
    wait_for('Editing draft')
    for columns in (120,40,100):resize(columns)
    send('y');wait_for('keep-my-drafty')
    send('\ty');wait_for('draft-permission complete')
    # The draft survived approval, tool output and the final answer; discard only this fixture text.
    assert 'keep-my-drafty'.encode() in capture[-3000:]
    send('\x15')
    send('/permission default\r');wait_for('default')
    send('/permission auto\r');wait_for('permission mode:')
    trust_start=len(capture)
    send('trust-fixture-request\r');wait_for('full-trust-fixture complete')
    assert b'permission required:' not in bytes(capture[trust_start:]) and 'Approve ·'.encode() not in bytes(capture[trust_start:])
    assert b'allowed without asking' not in bytes(capture[trust_start:])
    request_text=json.dumps(Handler.requests[-1],ensure_ascii=False)
    assert 'inherited-fixture-only' in request_text and 'full-trust-fixture-only' in request_text
    send('/sandbox\r');wait_for('not in force while in auto')
    send('/permission default\r');wait_for('permission mode:')
    send('/sandbox\r');wait_for('OS sandbox: on')
    send('/access\r');wait_for('Initial root:')
    start_approval=len(capture)
    send('permission-parent\r');wait_for('Approve · read')
    send('a\r')
    wait_for('check-4 — subagent done',timeout=20)
    # Allow all five reports to finish and verify they did not request the same approval again.
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        if select.select([master],[],[],0.1)[0]:capture.extend(os.read(master,65536))
    segment=bytes(capture[start_approval:])
    assert segment.count(b'read \xc2\xb7 always')==1, 'same approval must not repeat across parallel children'
    assert '▌ a'.encode() not in segment, 'approval input leaked into chat'
    send('/exit\r')
    deadline=time.monotonic()+15
    while proc.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try:capture.extend(os.read(master,65536))
            except OSError:break
    proc.wait(timeout=1)
    assert proc.returncode==0
    assert (work/'repo/value.ts').read_text()=='export const value = 2\n'
    assert b'\x1b[?1049h' not in capture, 'alternate screen must not be used'
    assert b'\x1b[3J' not in capture, 'resize must not clear native scrollback'
    assert b'\x1b[?1000h' not in capture, 'mouse must remain native'
    report=work/'metrics.json'
    cli=command+['-c',str(work/'repo'),'--no-color']
    once=subprocess.run(cli+['-p','hello','--report',str(report)],env=env,capture_output=True,timeout=15)
    assert once.returncode==0 and b'\x1b[' not in once.stdout
    metrics=json.loads(report.read_text());assert metrics['requests'] and metrics['tokens']['input']>0
    pipe=subprocess.run(cli,input=b'hello\n/exit\n',env=env,capture_output=True,timeout=15)
    assert pipe.returncode==0 and b'\x1b[' not in pipe.stdout
    interrupted=subprocess.Popen(cli+['-p','longwait','--report',str(report)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    time.sleep(0.8);interrupted.send_signal(2);interrupted.communicate(timeout=10)
    assert interrupted.returncode==130
    assert json.loads(report.read_text())['interruptions']==1
    resumed=subprocess.run(cli+['--continue','-p','hello'],env=env,capture_output=True,timeout=15)
    assert resumed.returncode==0
    # Exercise the first-run wizard too; the settings wizard alone missed this regression.
    os.close(master)
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',20,40,0,0))
    fresh_env={**env,'XDG_CONFIG_HOME':str(work/'fresh-config'),'XDG_DATA_HOME':str(work/'fresh-data'),'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8'}
    fresh_config=work/'fresh-config/alfa';fresh_config.mkdir(parents=True)
    (fresh_config/'config.json').write_text(json.dumps({'folders':{str(work/'repo'):{'trust':'trusted','seenAt':'2026-01-01'}}}))
    fresh_start=len(capture)
    proc=subprocess.Popen(cli,stdin=slave,stdout=slave,stderr=slave,env=fresh_env,start_new_session=True)
    os.close(slave)
    wait_for('Provider template')
    for text,needle in [('custom','Connection name'),('first-run','API protocol'),('openai-chat','API base URL'),('','Enter a complete http(s)'),(base,'Local authentication'),('key','API key —'),('fake-secret-onboard-fixture','Model ID'),('mock','Context window tokens'),('','Ready to connect?'),('test','Connected successfully')]:
        send(text+'\r');wait_for(needle)
    send('default\r');wait_for('alfa 0.')
    send('/exit\r')
    deadline=time.monotonic()+15
    while proc.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],0.1)[0]:
            try:capture.extend(os.read(master,65536))
            except OSError:break
    proc.wait(timeout=1)
    assert proc.returncode==0
    assert b'fake-secret-onboard-fixture' not in capture, 'credential must never be echoed'
    saved=json.loads((work/'fresh-config/alfa/config.json').read_text())
    assert saved['model']=='first-run/mock'
    assert saved.get('sandbox',False) is False
    assert b'OS sandbox:' not in capture[fresh_start:]
    assert 'fake-secret-onboard-fixture' not in json.dumps(saved)
    auth=json.loads((work/'fresh-data/alfa/auth.json').read_text())
    assert auth['first-run']['apiKey']=='fake-secret-onboard-fixture'
    (work/'transcript.txt').write_bytes(capture)
    print(json.dumps({'passed':True,'columns':[40,120,40,100],'checks':['CJK input','resize draft recovery 120→40→100','Ctrl-L draft recovery','approval overlay resize 120→40→100','default-allow edit diff','full detail','settings add local provider','discover saved provider models','save multiple models without switching','discovery sends no completion request','settings check approval returns to menu','actual mock API test','immediate switch','access list','clean exit','native scrollback','one-shot usage report','pipe output','SIGINT cleanup','resume after interruption','first-run wizard','empty endpoint retry','hidden credential entry','slash completion','cache debugger navigation and resize','context cache-hit link and noninteractive overview','growing tool history displays measured ceiling and utilization','five parallel agents share approval','approval keys stay out of chat'],'artifact':str(work/'transcript.txt')}))
finally:
    (work/'transcript.txt').write_bytes(capture)
    print('transcript:',work/'transcript.txt',file=sys.stderr)
    if proc.poll() is None:proc.kill();proc.wait()
    os.close(master);server.shutdown()
