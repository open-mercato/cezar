import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
sys.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n')
sys.stdout.flush()
time.sleep(30)
