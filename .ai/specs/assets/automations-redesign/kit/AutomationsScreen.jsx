const { Pill, StatusDot, Button, Icon, Segmented, Input, Textarea, Card, Chip, Kbd, Label, Switch, Select, BranchChip, DropdownMenu, CenteredState, TabBar, TabLink, Sheet } = window.CezarDesignSystem_3b4141;
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const pad = (n) => String(n).padStart(2, '0');
const hm = (h, m = 0) => pad(h) + ':' + pad(m);
function scheduleLabel(a) {
  if (a.kind === 'github') return 'on ' + a.event + ' · every ' + a.every + ' min';
  const s = a.sched;
  if (s.type === 'daily') return 'every day at ' + hm(s.hour, s.minute);
  if (s.type === 'weekdays') return 'weekdays at ' + hm(s.hour, s.minute);
  if (s.type === 'hours') return 'every ' + s.every + ' hours';
  return DAYS[s.day - 1] + 's at ' + hm(s.hour, s.minute);
}
function cronOf(a) {
  if (a.kind === 'github') return null;
  const s = a.sched;
  if (s.type === 'daily') return s.minute + ' ' + s.hour + ' * * *';
  if (s.type === 'weekdays') return s.minute + ' ' + s.hour + ' * * 1-5';
  if (s.type === 'hours') return '0 */' + s.every + ' * * *';
  return s.minute + ' ' + s.hour + ' * * ' + (s.day % 7);
}
// occurrences within the demo week (Mon 14 → Sun 20 Sep 2026) as { day:0-6, minutes }
function occurrences(a) {
  if (a.kind === 'github') return [];
  const s = a.sched, out = [];
  for (let d = 0; d < 14; d++) {
    if (s.type === 'daily') out.push({ day:d, min:s.hour*60 + s.minute });
    else if (s.type === 'weekdays') { if (d % 7 < 5) out.push({ day:d, min:s.hour*60 + s.minute }); }
    else if (s.type === 'hours') { for (let h = 0; h < 24; h += s.every) out.push({ day:d, min:h*60 }); }
    else if (d % 7 === s.day - 1) out.push({ day:d, min:s.hour*60 + s.minute });
  }
  return out;
}
const NOW = () => { const n = window.CZ_DATA.now; return { day:(n.getDay() + 6) % 7, min:n.getHours()*60 + n.getMinutes() }; };
const dayName = (d) => DAYS[d % 7];
function nextRuns(list, limit) {
  const now = NOW(), out = [];
  list.filter(a => a.enabled).forEach(a => occurrences(a).forEach(o => { const t = o.day*1440 + o.min, nt = now.day*1440 + now.min; if (t >= nt) out.push({ a, o, t }); }));
  return out.sort((x, y) => x.t - y.t).slice(0, limit);
}
const rel = (t) => { const now = NOW(); const dm = t - (now.day*1440 + now.min); if (dm < 60) return 'in ' + dm + 'm'; if (dm < 1440) return 'in ' + Math.round(dm/60) + 'h'; return 'in ' + Math.round(dm/1440) + 'd'; };

function AutomationsScreen({ go, sub, id }) {
  const [list, setList] = React.useState(window.CZ_DATA.automations);
  const [mode, setMode] = React.useState('list');
  const patch = (aid, p) => setList(l => l.map(a => a.id === aid ? { ...a, ...p } : a));
  const remove = (aid) => setList(l => l.filter(a => a.id !== aid));
  const duplicate = (a) => setList(l => [...l, { ...a, id:'a' + Date.now(), name:a.name + ' (copy)', enabled:false, runs7d:0, cost7d:'—', last:undefined }]);
  if (sub === 'new' || sub === 'edit') return <AutomationEditor key={sub === 'edit' ? id : 'new'} a={sub === 'edit' ? list.find(x => x.id === id) : null} onBack={() => go('automations')} onLog={() => go('automations', 'log', id)} onSave={(a) => { if (a.id) patch(a.id, a); else setList(l => [...l, { ...a, id:'a' + Date.now(), runs7d:0, cost7d:'—' }]); go('automations'); }} />;
  if (sub === 'log') return <AutomationLogView key={id} a={list.find(x => x.id === id)} go={go} />;
  const actions = { patch, remove, duplicate, go };
  return (
    <div style={{ display:'flex', flexDirection:'column', minHeight:'100%' }}>
      <header style={{ position:'sticky', top:0, zIndex:10, display:'flex', height:56, alignItems:'center', gap:12, borderBottom:'1px solid var(--border)', background:'var(--background)', padding:'0 20px' }}>
        <h1 style={{ margin:0, font:'600 16px var(--sans)' }}>Automations</h1>
        <Segmented value={mode} onValueChange={setMode} options={[{ value:'list', label:'List', count:list.length }, { value:'week', label:'Week' }, { value:'day', label:'Day' }]} />
        <div style={{ flex:1 }} />
        <span className="cz-auto-status" style={{ display:'inline-flex', alignItems:'center', gap:8, font:'400 12.5px var(--sans)', color:'var(--muted-foreground)', whiteSpace:'nowrap', minWidth:0, overflow:'hidden', textOverflow:'ellipsis' }}><StatusDot tone="success" />Scheduler running<span style={{ color:'var(--soft-foreground)' }}>·</span>GitHub available<span style={{ color:'var(--soft-foreground)' }}>·</span><span style={{ fontFamily:'var(--mono)', fontSize:12 }}>Europe/Warsaw</span></span>
        <Button style={{ flexShrink:0 }} onClick={() => go('automations', 'new')}><Icon name="plus" size={15} />New automation</Button>
      </header>
      {mode === 'list' ? <ListView list={list} {...actions} /> : mode === 'week' ? <WeekView list={list} go={go} /> : <DayView list={list} go={go} />}
    </div>
  );
}

function ListView({ list, patch, remove, duplicate, go }) {
  const [menu, setMenu] = React.useState(null);
  const [menuPos, setMenuPos] = React.useState(null);
  const TH = { height:38, borderBottom:'1px solid var(--border)', padding:'0 10px', textAlign:'left', font:'600 11px/1 var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', whiteSpace:'nowrap', color:'var(--soft-foreground)' };
  const TD = { height:48, borderBottom:'1px solid var(--border)', padding:'0 10px', whiteSpace:'nowrap', font:'400 13px/1 var(--sans)' };
  const upcoming = nextRuns(list, 12);
  const [rail, setRail] = React.useState(false);
  const dash = <span style={{ font:'400 12px var(--sans)', color:'var(--soft-foreground)' }}>—</span>;
  return (
    <div style={{ padding:20, display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:16, font:'400 12.5px var(--sans)', color:'var(--muted-foreground)', flexWrap:'wrap' }}>
        <span style={{ font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color:'var(--soft-foreground)' }}>This week</span>
        {[['66','runs'],['$13.4','spent'],['2','failed','danger'],['4h 12m','agent time']].map(([v, l, tone]) => <span key={l} style={{ display:'inline-flex', alignItems:'baseline', gap:5, whiteSpace:'nowrap', flexShrink:0 }}><b style={{ font:'600 14px var(--mono)', fontVariantNumeric:'tabular-nums', color: tone === 'danger' ? 'var(--danger)' : 'var(--foreground)' }}>{v}</b>{l}</span>)}
        <span style={{ display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap', flexShrink:0 }}><StatusDot tone="pending" pulse />{list.filter(a => a.kind === 'github' && a.enabled).length} GitHub polls continuous</span>
        <span style={{ flex:1 }} />
        <span style={{ display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap', flexShrink:0, minWidth:0 }}><Icon name="clock-3" size={13} style={{ color:'var(--soft-foreground)' }} />next <b style={{ font:'500 12.5px var(--mono)', color:'var(--foreground)' }}>{upcoming[0] ? hm(Math.floor(upcoming[0].o.min/60), upcoming[0].o.min%60) : '—'}</b> <span style={{ maxWidth:180, overflow:'hidden', textOverflow:'ellipsis' }}>{upcoming[0] ? upcoming[0].a.name : ''}</span></span>
        <Button variant="outline" size="sm" aria-expanded={rail} style={{ flexShrink:0 }} onClick={() => setRail(true)}><Icon name="calendar-clock" size={14} />Next runs<span style={{ font:'500 11px var(--mono)', color:'var(--muted-foreground)' }}>{upcoming.length}</span></Button>
      </div>
      <Card flush style={{ overflowX:'auto', minWidth:0 }}>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead><tr><th style={{ ...TH, paddingLeft:16 }}>State</th><th style={TH}>Automation</th><th style={TH}>Trigger</th><th className="cz-auto-wide" style={TH}>Runs as</th><th style={TH}>Next run</th><th style={TH}>Last run</th><th className="cz-auto-wide" style={{ ...TH, textAlign:'right' }}>Runs 7d</th><th className="cz-auto-wide" style={{ ...TH, textAlign:'right' }}>Cost 7d</th><th style={{ ...TH, paddingRight:16 }}></th></tr></thead>
          <tbody>{list.map((a, i) => {
            const last = i === list.length - 1; const td = (x) => ({ ...TD, ...x, borderBottom: last ? 0 : TD.borderBottom });
            const nx = a.kind === 'github' ? 'continuous' : (nextRuns([a], 1)[0] ? dayName(nextRuns([a],1)[0].o.day) + ' ' + hm(Math.floor(nextRuns([a],1)[0].o.min/60), nextRuns([a],1)[0].o.min%60) : '—');
            return <tr key={a.id} className="cz-row" style={{ cursor:'pointer', opacity: a.enabled ? 1 : .6 }} onClick={() => go('automations', 'edit', a.id)}>
              <td style={td({ paddingLeft:16 })}><Pill dot={a.enabled ? 'success' : 'neutral'} pulse={a.enabled && a.kind === 'github'}>{a.enabled ? 'enabled' : 'paused'}</Pill></td>
              <td style={td({ minWidth:200, maxWidth:0 })}><span style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}><Icon name={a.kind === 'github' ? 'github' : 'clock-3'} size={14} style={{ color:'var(--soft-foreground)' }} /><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', font:'500 13px var(--sans)' }}>{a.name}</span>{a.dispatch ? <span title={'dispatch · up to ' + a.maxChildren + ' subtasks'} style={{ flexShrink:0, display:'inline-flex', alignItems:'center', gap:3, borderRadius:999, background:'var(--muted)', padding:'1px 6px', font:'500 10.5px var(--sans)', color:'var(--muted-foreground)' }}><Icon name="git-fork" size={10} />×{a.maxChildren}</span> : null}</span></td>
              <td style={td({ font:'400 12px var(--mono)', color:'var(--muted-foreground)', maxWidth:260, overflow:'hidden', textOverflow:'ellipsis' })} title={scheduleLabel(a)}>{scheduleLabel(a)}</td>
              <td className="cz-auto-wide" style={td({ font:'400 12px var(--sans)', color:'var(--muted-foreground)' })}><span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>{a.workflow}<span style={{ color:'var(--soft-foreground)' }}>·</span>{a.runner}{a.autonomous ? <span title="autonomous" style={{ color:'var(--soft-foreground)' }}>·</span> : null}{a.autonomous ? <Icon name="zap" size={11} style={{ color:'var(--soft-foreground)' }} /> : null}<span style={{ color:'var(--soft-foreground)' }}>·</span><span style={{ fontFamily:'var(--mono)', fontSize:11.5 }}>{a.budget}</span></span></td>
              <td style={td({ font:'400 12px var(--mono)', color: a.enabled ? 'var(--foreground)' : 'var(--soft-foreground)', fontVariantNumeric:'tabular-nums' })}>{a.enabled ? nx : '—'}</td>
              <td style={td()}>{a.last ? <span style={{ display:'inline-flex', alignItems:'center', gap:8 }}><StatusDot tone={a.last.tone} /><span style={{ color:'var(--muted-foreground)', fontSize:12.5 }}>{a.last.label}</span><span style={{ font:'400 11.5px var(--sans)', color:'var(--soft-foreground)' }}>{a.last.age}</span><a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); go('thread', a.last.task); }} style={{ display:'inline-flex', alignItems:'center', gap:2, font:'600 10.5px var(--mono)', color:'var(--violet)', borderRadius:999, border:'1px solid color-mix(in srgb,var(--violet) 40%,transparent)', padding:'1px 6px' }}>task<Icon name="arrow-up-right" size={9} /></a></span> : dash}</td>
              <td className="cz-auto-wide" style={td({ textAlign:'right', font:'400 12px var(--mono)', color:'var(--muted-foreground)', fontVariantNumeric:'tabular-nums' })}>{a.runs7d}</td>
              <td className="cz-auto-wide" style={td({ textAlign:'right', font:'400 12px var(--mono)', color:'var(--muted-foreground)', fontVariantNumeric:'tabular-nums' })}>{a.cost7d}</td>
              <td style={td({ paddingRight:12, textAlign:'right' })}>
                <span style={{ display:'inline-flex', gap:2 }} onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="icon-sm" title="Run now" aria-label="Run now" onClick={() => go('thread', 't4')}><Icon name="play" size={13} /></Button>
                  <Button variant="ghost" size="icon-sm" title={a.enabled ? 'Pause' : 'Enable'} aria-label={a.enabled ? 'Pause' : 'Enable'} onClick={() => patch(a.id, { enabled: !a.enabled })}><Icon name={a.enabled ? 'pause' : 'power'} size={13} /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label="More" onClick={(e) => { setMenuPos(e.currentTarget.getBoundingClientRect().bottom + 4); setMenu(menu === a.id ? null : a.id); }}><Icon name="ellipsis" size={14} /></Button>
                </span>
                {menu === a.id ? <div style={{ position:'fixed', right:36, top: (menuPos || 120), zIndex:20 }} onClick={(e) => e.stopPropagation()}><DropdownMenu width={200} items={[{ icon:'pencil', label:'Edit', onSelect:() => go('automations', 'edit', a.id) }, { icon:'scroll-text', label:'View log', onSelect:() => go('automations', 'log', a.id) }, { icon:'copy', label:'Duplicate', onSelect:() => { duplicate(a); setMenu(null); } }, { icon:'terminal', label:'Copy as CLI', onSelect:() => setMenu(null) }, { type:'separator' }, { icon:'trash-2', label:'Delete', destructive:true, onSelect:() => remove(a.id) }]} /></div> : null}
              </td>
            </tr>; })}
          </tbody>
        </table>
      </Card>
      <Sheet open={rail} side="right" width={360} title={<span style={{ display:'inline-flex', alignItems:'center', gap:8 }}><Icon name="calendar-clock" size={16} />Next runs</span>} onOpenChange={setRail}>
        <div style={{ margin:'0 -16px' }}>
          {upcoming.map((u, i) => <div key={i} className="cz-row" onClick={() => { setRail(false); go('automations', 'edit', u.a.id); }} style={{ display:'grid', gridTemplateColumns:'76px 1fr auto', alignItems:'center', gap:8, padding:'8px 16px', font:'400 13px var(--sans)', cursor:'pointer' }}>
            <span style={{ font:'500 12px var(--mono)', color:'var(--muted-foreground)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{u.o.day === NOW().day ? '' : dayName(u.o.day) + ' '}{hm(Math.floor(u.o.min/60), u.o.min%60)}</span>
            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', font:'500 13px var(--sans)' }}>{u.a.name}</span>
            <span style={{ font:'400 11px var(--sans)', color:'var(--soft-foreground)', whiteSpace:'nowrap' }}>{rel(u.t)}</span>
          </div>)}
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px 4px', borderTop:'1px solid var(--border)', marginTop:6, font:'400 12px var(--sans)', color:'var(--muted-foreground)' }}><StatusDot tone="pending" pulse />{list.filter(a => a.kind === 'github' && a.enabled).length} GitHub polls running continuously</div>
        </div>
      </Sheet>
    </div>
  );
}

const HOUR_H = 34;
function EventBlock({ a, min, go, wide }) {
  return <button type="button" onClick={() => go('automations', 'edit', a.id)} title={a.name + ' · ' + hm(Math.floor(min/60), min%60)} style={{ position:'absolute', left:3, right:3, top:(min/60)*HOUR_H + 1, height: wide ? 48 : 24, borderRadius:6, border:'1px solid var(--border)', background:'var(--card)', boxShadow:'var(--shadow-xs)', padding: wide ? '5px 8px' : '0 6px', display:'flex', flexDirection: wide ? 'column' : 'row', alignItems: wide ? 'flex-start' : 'center', gap: wide ? 3 : 6, font:'500 11.5px/1.3 var(--sans)', color:'var(--foreground)', cursor:'pointer', textAlign:'left', overflow:'hidden', opacity: a.enabled ? 1 : .5 }}>
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, minWidth:0 }}><StatusDot tone={a.runner === 'codex' ? 'violet' : 'success'} /><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</span></span>
    {wide ? <span style={{ font:'400 10.5px/1.3 var(--mono)', color:'var(--muted-foreground)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:'100%' }}>{hm(Math.floor(min/60), min%60)} · {a.workflow} · {a.runner}</span> : null}
  </button>;
}
function NowLine() { const n = NOW(); return <div aria-hidden="true" style={{ position:'absolute', left:0, right:0, top:(n.min/60)*HOUR_H, height:2, background:'var(--primary)', zIndex:2 }}><span style={{ position:'absolute', left:-3, top:-3, width:8, height:8, borderRadius:999, background:'var(--primary)' }} /></div>; }
function HourGutter() { return <div style={{ width:48, flexShrink:0 }}>{Array.from({ length:24 }, (_, h) => <div key={h} style={{ height:HOUR_H, font:'400 10.5px var(--mono)', color:'var(--soft-foreground)', textAlign:'right', paddingRight:8, transform:'translateY(-6px)' }}>{h ? hm(h) : ''}</div>)}</div>; }
function WeekView({ list, go }) {
  const now = NOW();
  const gh = list.filter(a => a.kind === 'github' && a.enabled);
  return (
    <div style={{ padding:20 }}>
      <Card flush>
        <div style={{ display:'grid', gridTemplateColumns:'48px repeat(7,minmax(0,1fr))', borderBottom:'1px solid var(--border)' }}>
          <div />
          {DAYS.map((d, i) => <div key={d} style={{ padding:'10px 8px', borderLeft:'1px solid var(--border)', font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color: i === now.day ? 'var(--foreground)' : 'var(--soft-foreground)', display:'flex', alignItems:'center', gap:8 }}>{d}<span style={{ font:'500 13px var(--sans)', letterSpacing:0, textTransform:'none', color: i === now.day ? 'var(--primary-foreground)' : 'var(--muted-foreground)', background: i === now.day ? 'var(--primary)' : 'transparent', borderRadius:999, padding:'1px 7px' }}>{14 + i}</span></div>)}
        </div>
        {gh.length ? <div style={{ display:'grid', gridTemplateColumns:'48px minmax(0,1fr)', borderBottom:'1px solid var(--border)' }}>
          <div style={{ padding:'8px 8px 8px 0', font:'400 10.5px var(--mono)', color:'var(--soft-foreground)', textAlign:'right' }}>poll</div>
          <div style={{ padding:'6px 8px', display:'flex', flexDirection:'column', gap:4, borderLeft:'1px solid var(--border)' }}>{gh.map(a => <div key={a.id} style={{ display:'flex', alignItems:'center', gap:8, height:22, borderRadius:6, background:'color-mix(in srgb,var(--violet) 8%,transparent)', border:'1px solid color-mix(in srgb,var(--violet) 25%,transparent)', padding:'0 8px', font:'500 11.5px var(--sans)', minWidth:0, overflow:'hidden' }}><Icon name="github" size={12} style={{ color:'var(--violet)' }} /><span style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{a.name}</span><span style={{ font:'400 10.5px var(--mono)', color:'var(--muted-foreground)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{scheduleLabel(a)}</span><span style={{ marginLeft:'auto', font:'400 10.5px var(--mono)', color:'var(--soft-foreground)', whiteSpace:'nowrap', flexShrink:0 }}>{a.runs7d} runs</span></div>)}</div>
        </div> : null}
        <div style={{ display:'flex', maxHeight:560, overflowY:'auto' }}>
          <HourGutter />
          {DAYS.map((d, i) => <div key={d} style={{ position:'relative', flex:1, minWidth:0, borderLeft:'1px solid var(--border)', height:24*HOUR_H, backgroundImage:'repeating-linear-gradient(to bottom,var(--border) 0 1px,transparent 1px ' + HOUR_H + 'px)', background: i === now.day ? 'color-mix(in srgb,var(--muted) 35%,transparent)' : undefined }}>
            {Array.from({ length:24 }, (_, h) => <div key={h} style={{ position:'absolute', left:0, right:0, top:h*HOUR_H, height:1, background:'var(--border)' }} />)}
            {i === now.day ? <NowLine /> : null}
            {list.flatMap(a => occurrences(a).filter(o => o.day === i).map((o, k) => <EventBlock key={a.id + k} a={a} min={o.min} go={go} />))}
          </div>)}
        </div>
      </Card>
    </div>
  );
}
function DayView({ list, go }) {
  const [day, setDay] = React.useState(NOW().day);
  const now = NOW();
  const evs = list.flatMap(a => occurrences(a).filter(o => o.day === day).map(o => ({ a, o }))).sort((x, y) => x.o.min - y.o.min);
  return (
    <div style={{ padding:20, display:'grid', gridTemplateColumns:'minmax(0,1fr) 320px', gap:16, alignItems:'start' }}>
      <Card flush>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', borderBottom:'1px solid var(--border)' }}>
          <Button variant="ghost" size="icon-sm" aria-label="Previous day" onClick={() => setDay((day + 6) % 7)}><Icon name="chevron-left" size={14} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next day" onClick={() => setDay((day + 1) % 7)}><Icon name="chevron-right" size={14} /></Button>
          <span style={{ font:'600 14px var(--sans)', whiteSpace:'nowrap' }}>{DAYS[day]} {14 + day} Sep</span>{day === now.day ? <Pill dot="success">today</Pill> : null}
          <span style={{ marginLeft:'auto', font:'400 12px var(--sans)', color:'var(--muted-foreground)', whiteSpace:'nowrap' }}>{evs.length} scheduled runs</span>
        </div>
        <div style={{ display:'flex', maxHeight:600, overflowY:'auto' }}>
          <HourGutter />
          <div style={{ position:'relative', flex:1, borderLeft:'1px solid var(--border)', height:24*HOUR_H }}>
            {Array.from({ length:24 }, (_, h) => <div key={h} style={{ position:'absolute', left:0, right:0, top:h*HOUR_H, height:1, background:'var(--border)' }} />)}
            {day === now.day ? <NowLine /> : null}
            {evs.map(({ a, o }, k) => <EventBlock key={k} a={a} min={o.min} go={go} wide />)}
          </div>
        </div>
      </Card>
      <Card flush style={{ padding:'12px 0' }}>
        <div style={{ padding:'0 14px 8px', font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color:'var(--soft-foreground)' }}>Agenda</div>
        {evs.map(({ a, o }, k) => { const past = day < now.day || (day === now.day && o.min < now.min); return <div key={k} onClick={() => go('automations', 'edit', a.id)} className="cz-row" style={{ display:'grid', gridTemplateColumns:'48px 1fr', gap:10, padding:'8px 14px', cursor:'pointer' }}>
          <span style={{ font:'500 12px var(--mono)', color: past ? 'var(--soft-foreground)' : 'var(--foreground)', fontVariantNumeric:'tabular-nums' }}>{hm(Math.floor(o.min/60), o.min%60)}</span>
          <span style={{ minWidth:0 }}><span style={{ display:'flex', alignItems:'center', gap:8, font:'500 13px var(--sans)', color: past ? 'var(--muted-foreground)' : 'inherit' }}>{past && a.last ? <StatusDot tone={a.last.tone} /> : <StatusDot tone="neutral" />}<span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</span></span><span style={{ display:'block', font:'400 11.5px/1.4 var(--sans)', color:'var(--soft-foreground)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.prompt}</span></span>
        </div>; })}
        {!evs.length ? <p style={{ margin:0, padding:'8px 14px', font:'400 12.5px var(--sans)', color:'var(--soft-foreground)' }}>Nothing scheduled — GitHub polls still run.</p> : null}
      </Card>
    </div>
  );
}

const PROMPT_TEMPLATES = [
  { name:'Bump deps', prompt:'Run npm outdated, bump patch and minor versions, run the test suite, open a draft PR titled "chore: deps" if anything changed.' },
  { name:'Triage issue', prompt:'Read {{github.url}}. Label it (bug / feature / question), add a one-paragraph repro or a clarification request. Never close it.' },
  { name:'Review PR', prompt:'Review {{github.url}} for real issues only: correctness, security, missing tests. Comment inline; never approve or merge.' },
  { name:'Changelog', prompt:'Collect merged PRs since the last run, group by area, write CHANGELOG.md entries in the existing voice, open a draft PR.' },
  { name:'Flaky tests', prompt:'Run the unit suite 5×. Quarantine any test that fails at least once but not always, and open an issue with its failure log.' },
];
function AutomationEditor({ a, onBack, onLog, onSave }) {
  const [f, setF] = React.useState(a || { name:'', kind:'schedule', sched:{ type:'daily', hour:4, minute:0 }, event:'issue.opened', every:5, enabled:false, prompt:'', workflow:'quick-task', runner:'claude', model:'sonnet', autonomous:true, budget:'$1.00', dispatch:false, maxChildren:4, reviewChild:true });
  const [showTpl, setShowTpl] = React.useState(!a);
  const set = (p) => setF(x => ({ ...x, ...p }));
  const setS = (p) => setF(x => ({ ...x, sched:{ ...x.sched, ...p } }));
  const type = f.sched.type;
  const preview = nextRuns([{ ...f, enabled:true }], 5);
  const cli = f.kind === 'github' ? `cez automation add --name "${f.name || 'untitled'}" --on ${f.event} --every ${f.every}m --workflow ${f.workflow} --runner ${f.runner} --prompt "…"` : `cez automation add --name "${f.name || 'untitled'}" --cron "${cronOf(f)}" --workflow ${f.workflow} --runner ${f.runner}${f.autonomous ? ' --autonomous' : ''} --budget ${f.budget}${f.dispatch ? ' --dispatch --max-children ' + f.maxChildren + (f.reviewChild ? ' --review' : '') : ''} --prompt "…"`;
  const Section = ({ title, children }) => <Card style={{ padding:'0 24px', gap:0 }}><div style={{ padding:'16px 0 4px', font:'600 14px var(--sans)' }}>{title}</div><div style={{ display:'flex', flexDirection:'column', gap:14, padding:'10px 0 20px' }}>{children}</div></Card>;
  const TimeRow = () => <div style={{ display:'flex', alignItems:'center', gap:8, font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}>at<Input value={pad(f.sched.hour ?? 4)} onChange={(e) => setS({ hour: Math.min(23, Number(e.target.value) || 0) })} style={{ width:56, textAlign:'center', fontFamily:'var(--mono)' }} />:<Input value={pad(f.sched.minute ?? 0)} onChange={(e) => setS({ minute: Math.min(59, Number(e.target.value) || 0) })} style={{ width:56, textAlign:'center', fontFamily:'var(--mono)' }} /><span style={{ fontFamily:'var(--mono)', fontSize:12 }}>Europe/Warsaw</span></div>;
  return (
    <div style={{ display:'flex', flexDirection:'column', minHeight:'100%' }}>
      <header style={{ position:'sticky', top:0, zIndex:10, display:'flex', height:56, alignItems:'center', gap:12, borderBottom:'1px solid var(--border)', background:'var(--background)', padding:'0 20px' }}>
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}><Icon name="arrow-left" size={15} /></Button>
        <h1 style={{ margin:0, font:'600 16px var(--sans)' }}>{a ? 'Edit automation' : 'New automation'}</h1>
        {a ? <Pill dot={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'enabled' : 'paused'}</Pill> : null}
        <div style={{ flex:1 }} />
        {!a ? <Button variant="ghost" size="sm" onClick={() => setShowTpl(s => !s)}><Icon name="layout-template" size={14} />{showTpl ? 'Hide templates' : 'Start from a template'}</Button> : null}
        <Button variant="outline" onClick={onBack}>Cancel</Button>
        <Button onClick={() => onSave(f)} disabled={!f.name.trim() || !f.prompt.trim()}>{a ? 'Save changes' : f.enabled ? 'Save and enable' : 'Save paused'}</Button>
      </header>
      <div style={{ padding:20, display:'flex', justifyContent:'center' }}>
        <div style={{ width:'100%', maxWidth:1080, display:'grid', gridTemplateColumns:'minmax(0,1fr) 320px', gap:16, alignItems:'start' }}>
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {showTpl ? <TemplatePalette onPick={(t) => { set({ name:t.name, prompt:t.prompt, kind:t.kind, sched: t.sched || f.sched }); setShowTpl(false); }} /> : null}
            <Section title="Name">
              <Input placeholder="Nightly dependency bump" value={f.name} onChange={(e) => set({ name:e.target.value })} style={{ maxWidth:420, fontSize:15 }} />
            </Section>
            <Section title="When">
              <Segmented value={f.kind} onValueChange={(v) => set({ kind:v })} options={[{ value:'schedule', label:'On a schedule' }, { value:'github', label:'When GitHub changes' }]} />
              {f.kind === 'schedule' ? <>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>{[['daily','Every day'],['weekdays','Weekdays'],['weekly','Weekly'],['hours','Every N hours']].map(([v, l]) => <Chip key={v} active={type === v} onClick={() => setS({ type:v, hour:f.sched.hour ?? 4, minute:f.sched.minute ?? 0, every:f.sched.every ?? 6, day:f.sched.day ?? 1 })}>{l}</Chip>)}</div>
                {type === 'weekly' ? <div style={{ display:'flex', gap:6 }}>{DAYS.map((d, i) => <Chip key={d} active={f.sched.day === i + 1} onClick={() => setS({ day:i + 1 })} style={{ padding:'0 9px' }}>{d}</Chip>)}</div> : null}
                {type === 'hours' ? <div style={{ display:'flex', alignItems:'center', gap:8, font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}>every<Select value={String(f.sched.every)} onValueChange={(v) => setS({ every:Number(v) })} options={[1,2,3,4,6,8,12].map(n => ({ value:String(n), label:n + ' h' }))} />starting at 00:00</div> : <TimeRow />}
                <div style={{ display:'flex', alignItems:'center', gap:10, font:'400 12px var(--mono)', color:'var(--soft-foreground)' }}><span>cron</span><BranchChip>{cronOf(f)}</BranchChip></div>
              </> : <>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>{['issue.opened','issue.labeled','pull_request.opened','pull_request.review_requested','release.published'].map(ev => <Chip key={ev} active={f.event === ev} onClick={() => set({ event:ev })} style={{ fontFamily:'var(--mono)' }}>{ev}</Chip>)}</div>
                <div style={{ display:'flex', alignItems:'center', gap:8, font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}>poll every<Select value={String(f.every)} onValueChange={(v) => set({ every:Number(v) })} options={[2,5,10,15,30,60].map(n => ({ value:String(n), label:n + ' min' }))} />· last 7 days · maximum 25 records</div>
              </>}
            </Section>
            <Section title="What to run">
              <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', font:'400 12px var(--sans)', color:'var(--soft-foreground)' }}><Icon name="file-text" size={12} />Prompt templates{PROMPT_TEMPLATES.map(t => <Chip key={t.name} onClick={() => set({ prompt:t.prompt })} style={{ height:24, fontSize:11.5 }}>{t.name}</Chip>)}<Chip icon="settings-2" style={{ height:24, fontSize:11.5, borderStyle:'dashed' }}>Manage…</Chip></div>
              <Textarea rows={5} placeholder="Describe the task the agent should do each time. Placeholders: {{date}}, {{project}}" value={f.prompt} onChange={(e) => set({ prompt:e.target.value })} style={{ minHeight:104, fontSize:14, lineHeight:1.55 }} />
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                <Chip chevron icon="workflow">{f.workflow}</Chip><Chip chevron>{f.runner}</Chip><Chip chevron>{f.model}</Chip><Chip chevron>base: main</Chip>
                <span style={{ flex:1 }} />
                <Label style={{ font:'500 13px var(--sans)' }}>Autonomous <Switch checked={f.autonomous} onCheckedChange={(v) => set({ autonomous:v })} /></Label>
                <span style={{ display:'inline-flex', alignItems:'center', gap:6, font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}>budget per run<Input value={f.budget} onChange={(e) => set({ budget:e.target.value })} style={{ width:72, textAlign:'right', fontFamily:'var(--mono)' }} /></span>
              </div>
              <p style={{ margin:0, font:'400 12px/1.5 var(--sans)', color:'var(--soft-foreground)' }}>Each run is an ordinary cezar task in its own worktree — it queues behind the parallel cap like anything else and never auto-merges.</p>
              <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, borderTop:'1px solid var(--border)', paddingTop:12, font:'400 13px var(--sans)', color:'var(--muted-foreground)' }} title="Let this run start its own subtasks with cez task create — each in a worktree forked off its branch, reporting back into the parent session.">
                <Label style={{ font:'500 13px var(--sans)', color:'var(--foreground)' }}><Icon name="git-fork" size={14} style={{ color: f.dispatch ? 'var(--violet)' : 'var(--soft-foreground)' }} />Dispatch<Switch checked={!!f.dispatch} onCheckedChange={(v) => set({ dispatch:v })} /></Label>
                {f.dispatch ? <>
                  <span style={{ color:'var(--soft-foreground)' }}>·</span>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>up to<Select size="sm" value={String(f.maxChildren)} onValueChange={(v) => set({ maxChildren:Number(v) })} options={[1,2,4,6,8].map(n => ({ value:String(n), label:String(n) }))} />subtasks</span>
                  <span style={{ color:'var(--soft-foreground)' }}>·</span>
                  <Label style={{ font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}><Switch size="sm" checked={!!f.reviewChild} onCheckedChange={(v) => set({ reviewChild:v })} />review child</Label>
                  <span style={{ marginLeft:'auto', font:'400 11.5px var(--sans)', color:'var(--soft-foreground)', whiteSpace:'nowrap' }}>≤ {f.maxChildren + (f.reviewChild ? 1 : 0)} agents · shares {f.budget}</span>
                </> : null}
              </div>
            </Section>
            <Section title="Enable">
              <Label style={{ font:'500 13px var(--sans)' }}><Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled:v })} />Enabled{f.kind === 'github' ? <span style={{ font:'400 12px var(--sans)', color:'var(--muted-foreground)' }}> — from a current-time baseline; existing matches will not launch</span> : null}</Label>
            </Section>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:12, position:'sticky', top:76 }}>
            <Card flush style={{ padding:'12px 0 8px' }}>
              <div style={{ padding:'0 14px 8px', font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color:'var(--soft-foreground)' }}>{f.kind === 'github' ? 'How it polls' : 'Next 5 runs'}</div>
              {f.kind === 'github' ? <p style={{ margin:0, padding:'0 14px 6px', font:'400 12.5px/1.5 var(--sans)', color:'var(--muted-foreground)' }}>Checks GitHub every {f.every} min while cezar is open, through your <code style={{ fontSize:12 }}>gh</code>. No webhook or public URL required.</p> :
                preview.map((u, i) => <div key={i} style={{ display:'flex', gap:10, padding:'5px 14px', font:'400 13px var(--sans)' }}><span style={{ font:'500 12px var(--mono)', color:'var(--foreground)', fontVariantNumeric:'tabular-nums', width:82, whiteSpace:'nowrap', flexShrink:0 }}>{dayName(u.o.day)} {hm(Math.floor(u.o.min/60), u.o.min%60)}</span><span style={{ color:'var(--soft-foreground)', fontSize:11.5, whiteSpace:'nowrap' }}>{rel(u.t)}</span></div>)}
            </Card>
            <Card flush style={{ padding:'12px 14px' }}>
              <div style={{ display:'flex', alignItems:'center', marginBottom:8 }}><span style={{ font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color:'var(--soft-foreground)' }}>Copy as CLI</span><Button variant="ghost" size="sm" style={{ marginLeft:'auto', height:24 }}><Icon name="copy" size={12} />Copy</Button></div>
              <pre style={{ margin:0, whiteSpace:'pre-wrap', wordBreak:'break-word', font:'400 11.5px/1.6 var(--mono)', color:'var(--muted-foreground)', background:'var(--card-2)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 10px' }}>{cli}</pre>
              <p style={{ margin:'8px 0 0', font:'400 11.5px/1.5 var(--sans)', color:'var(--soft-foreground)' }}>Same definition, saved to <code style={{ fontSize:11 }}>.ai/cezar/automations/</code> — commit it to share with the team.</p>
            </Card>
            {a && a.last ? <Card flush style={{ padding:'12px 14px' }}><div style={{ font:'600 11px var(--sans)', letterSpacing:'.05em', textTransform:'uppercase', color:'var(--soft-foreground)', marginBottom:8 }}>Last run</div><div style={{ display:'flex', alignItems:'center', gap:8, font:'400 13px var(--sans)' }}><StatusDot tone={a.last.tone} />{a.last.label}<span style={{ color:'var(--soft-foreground)', fontSize:11.5 }}>{a.last.age}</span><span style={{ marginLeft:'auto', font:'400 12px var(--mono)', color:'var(--muted-foreground)' }}>{a.last.cost}</span></div><div style={{ display:'flex', gap:6, marginTop:10 }}><Button variant="outline" size="sm"><Icon name="play" size={12} />Run now</Button><Button variant="ghost" size="sm" onClick={onLog}><Icon name="scroll-text" size={12} />View log</Button></div></Card> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplatePalette({ onPick }) {
  const [tab, setTab] = React.useState('builtin');
  const t = window.CZ_DATA.templates;
  const items = tab === 'builtin' ? t.builtin : t.mine;
  const toSched = (when) => { const m = when.match(/(\d\d):(\d\d)/); const h = m ? Number(m[1]) : 4; if (/Every day/.test(when)) return { type:'daily', hour:h, minute:0 }; if (/Weekdays/.test(when)) return { type:'weekdays', hour:h, minute:0 }; if (/Every (\d+) hours/.test(when)) return { type:'hours', every:Number(when.match(/Every (\d+)/)[1]) }; const d = DAYS.findIndex(x => when.startsWith(x)); return { type:'weekly', day: d + 1 || 5, hour:h, minute:0 }; };
  return (
    <Card flush style={{ padding:'0 0 12px' }}>
      <div style={{ display:'flex', alignItems:'flex-end', gap:12, padding:'10px 16px 0', borderBottom:'1px solid var(--border)' }}>
        <TabBar style={{ borderBottom:0, flexShrink:0 }}><TabLink active={tab === 'builtin'} onClick={() => setTab('builtin')}>Built-in</TabLink><TabLink active={tab === 'mine'} onClick={() => setTab('mine')}>From your other projects</TabLink></TabBar>
        <span style={{ marginLeft:'auto', paddingBottom:8, font:'400 12px var(--sans)', color:'var(--soft-foreground)', minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tab === 'builtin' ? 'Ship with cezar' : 'Registered in ~/.cezar/config.json'}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:10, padding:'12px 16px 0' }}>
        {items.map((it, i) => <div key={i} style={{ border:'1px solid var(--border)', borderRadius:10, background:'var(--card-2)', padding:'10px 12px', display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, font:'600 13px var(--sans)' }}><Icon name={it.kind === 'github' ? 'github' : 'clock-3'} size={13} style={{ color:'var(--soft-foreground)' }} /><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.name}</span>{it.project ? <BranchChip style={{ marginLeft:'auto' }}>{it.project}</BranchChip> : null}</div>
          <div style={{ font:'400 11.5px var(--mono)', color:'var(--muted-foreground)' }}>{it.when}</div>
          <div style={{ font:'400 12px/1.45 var(--sans)', color:'var(--soft-foreground)', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>{it.prompt}</div>
          <Button variant="outline" size="sm" style={{ alignSelf:'flex-start', marginTop:2 }} onClick={() => onPick({ ...it, sched: it.kind === 'schedule' ? toSched(it.when) : undefined })}>Use this</Button>
        </div>)}
      </div>
    </Card>
  );
}

function AutomationLogView({ a, go }) {
  const recs = [
    { t:'Wed 04:00', tone:'success', r:'launched', note:'3 packages bumped · tests green', task:'t15', cost:'$0.33', children:[{ kind:'implement', title:'Bump vite 8.1.4 → 8.2.0', tone:'success', task:'t10', cost:'$0.11' }, { kind:'implement', title:'Bump vitest 4.1.10 → 4.2.1', tone:'success', task:'t11', cost:'$0.09' }, { kind:'review', title:'Judge the combined branch', tone:'success', task:'t12', cost:'$0.05' }] },
    { t:'Tue 04:00', tone:'success', r:'launched', note:'1 package bumped', task:'t11', cost:'$0.29' },
    { t:'Mon 04:00', tone:'neutral', r:'skipped', note:'nothing outdated — no task created', cost:'—' },
    { t:'Sun 04:00', tone:'danger', r:'failed', note:'npm install exited 1 (ENOTFOUND registry.npmjs.org)', task:'t13', cost:'$0.04' },
    { t:'Sat 04:00', tone:'success', r:'launched', note:'2 packages bumped', task:'t14', cost:'$0.41' },
  ];
  return (
    <div style={{ display:'flex', flexDirection:'column', minHeight:'100%' }}>
      <header style={{ position:'sticky', top:0, zIndex:10, display:'flex', height:56, alignItems:'center', gap:12, borderBottom:'1px solid var(--border)', background:'var(--background)', padding:'0 20px' }}>
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => go('automations')}><Icon name="arrow-left" size={15} /></Button>
        <h1 style={{ margin:0, font:'600 16px var(--sans)' }}>{a ? a.name : 'Automation'}</h1><span style={{ font:'400 13px var(--sans)', color:'var(--muted-foreground)' }}>· execution log</span>
        <div style={{ flex:1 }} /><Button variant="outline" size="sm" onClick={() => go('automations', 'edit', a.id)}><Icon name="pencil" size={13} />Edit</Button>
      </header>
      <div style={{ padding:20, display:'flex', justifyContent:'center' }}>
        <Card flush style={{ width:'100%', maxWidth:820 }}>
          {recs.map((r, i) => <div key={i} style={{ display:'grid', gridTemplateColumns:'90px 110px 1fr auto auto', alignItems:'center', rowGap:8, columnGap:12, padding:'12px 16px', borderBottom: i < recs.length - 1 ? '1px solid var(--border)' : 0, font:'400 13px var(--sans)' }}>
            <span style={{ font:'500 12px var(--mono)', color:'var(--muted-foreground)', fontVariantNumeric:'tabular-nums' }}>{r.t}</span>
            <Pill dot={r.tone}>{r.r}</Pill>
            <span style={{ color: r.tone === 'danger' ? 'var(--danger)' : 'var(--muted-foreground)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.note}</span>
            <span style={{ font:'400 12px var(--mono)', color:'var(--soft-foreground)' }}>{r.cost}</span>
            {r.task ? <Button variant="ghost" size="sm" onClick={() => go('thread', r.task)}>Open task<Icon name="arrow-up-right" size={12} /></Button> : <span />}
            {r.children ? <div style={{ gridColumn:'1 / -1', display:'flex', flexDirection:'column', gap:4, paddingLeft:14 }}>{r.children.map((c, j) => <div key={j} style={{ display:'grid', gridTemplateColumns:'14px 70px 1fr auto auto', alignItems:'center', gap:10, font:'400 12.5px var(--sans)' }}><span style={{ font:'400 11px var(--mono)', color:'var(--soft-foreground)' }}>└</span><span style={{ borderRadius:999, background:'var(--muted)', padding:'1px 6px', font:'500 10.5px var(--sans)', color:'var(--muted-foreground)', width:'fit-content' }}>{c.kind}</span><span style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}><StatusDot tone={c.tone} /><span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.title}</span></span><span style={{ font:'400 11.5px var(--mono)', color:'var(--soft-foreground)' }}>{c.cost}</span><Button variant="ghost" size="sm" style={{ height:24 }} onClick={() => go('thread', c.task)}>Open<Icon name="arrow-up-right" size={11} /></Button></div>)}</div> : null}
          </div>)}
        </Card>
      </div>
    </div>
  );
}
Object.assign(window, { AutomationsScreen });
