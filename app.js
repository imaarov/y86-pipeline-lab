(function(){
'use strict';

// ================= Example programs =================
const EXAMPLES = [
  { key:'independent', name:'Independent instructions', desc:'No dependencies at all - a clean, fully-overlapped pipeline.',
    src:
`# Three instructions that don't touch each other's registers.
# Watch them overlap perfectly: F/D/E/M/W all busy every cycle.
irmovl $10, %eax
irmovl $20, %ebx
irmovl $30, %ecx
halt` },

  { key:'safe-gap', name:'Dependency with a safe gap', desc:'Producer and consumer far enough apart that no hazard occurs.',
    src:
`# edx is produced by I1 and consumed by I4. By the time I4 reaches
# Decode, edx has already been written back - no forwarding even needed.
irmovl $10, %edx
irmovl $1, %eax
irmovl $2, %ebx
addl %edx, %eax
halt` },

  { key:'alu-forward', name:'ALU-to-ALU forwarding', desc:'Back-to-back dependent adds - needs the fastest forwarding path.',
    src:
`# addl immediately depends on the irmovl right before it, and then
# on the result of the FIRST addl too. Forwarding from Execute and
# from Memory both kick in here, one cycle apart.
irmovl $4, %eax
addl %eax, %eax
addl %eax, %eax
halt` },

  { key:'load-use', name:'Load-use hazard', desc:'A value fresh out of memory, needed immediately - forwarding alone cannot save this one.',
    src:
`# ecx is loaded from memory, then used on the VERY next instruction.
# Even with forwarding on, this needs one unavoidable stall cycle,
# because the loaded value doesn't exist until Memory finishes.
irmovl $9, %ebx
rmmovl %ebx, 0(%ebx)
mrmovl 0(%ebx), %ecx
addl %ecx, %ebx
halt` },

  { key:'branch-nottaken', name:'Branch, not taken', desc:'Prediction was right - the fall-through path just continues.',
    src:
`# 5 - 3 is not <= 0, so this branch is NOT taken.
# We predicted not-taken, so nothing gets flushed - free lunch.
irmovl $5, %eax
irmovl $3, %ebx
subl %ebx, %eax
jle skip
irmovl $111, %ecx
skip:
irmovl $222, %edx
halt` },

  { key:'branch-mispredict', name:'Branch misprediction + flush', desc:'Prediction was wrong - two wrong-path instructions get flushed.',
    src:
`# 1 - 1 == 0, so this branch IS taken - but we predicted not-taken.
# Watch the instruction after the jump get fetched, then crossed out
# and replaced with a bubble once the branch resolves in Execute.
irmovl $1, %eax
irmovl $1, %ebx
subl %ebx, %eax
je skip
irmovl $999, %ecx
skip:
irmovl $7, %edx
halt` },

  { key:'call-ret', name:'CALL / RET', desc:'A function call and return - watch the stack and the 3-cycle RET hold.',
    src:
`# call pushes the return address (valP) and jumps to the target.
# ret has to wait until it reaches Write-back before the CPU even
# knows what the next PC is - that costs 3 bubble cycles by design.
irmovl $200, %esp
irmovl $200, %ebp
call myfunc
irmovl $42, %edx
halt
myfunc:
irmovl $9, %eax
ret` },

  { key:'push-pop', name:'PUSHL / POPL', desc:'Stack push and pop, and how esp moves on both.',
    src:
`irmovl $200, %esp
irmovl $77, %eax
pushl %eax
irmovl $0, %eax
popl %ebx
halt` },

  { key:'broken-dst', name:'Buggy mode: no destination ID', desc:'Intentionally broken - shows why dstE must travel WITH the value.',
    src:
`# This program is fine on a CORRECT machine. Turn off forwarding
# above and watch %eax silently keep a stale value instead of the
# freshly-computed one - a live demo of what happens when a value
# and its destination register aren't kept tightly bound together.
irmovl $50, %eax
irmovl $1, %ebx
addl %ebx, %eax
addl %ebx, %eax
halt` },
];

// ================= state =================
let asm = null;
let machine = null;
let opts = { forwarding:true, stalls:true, predictTaken:false };
let running = false;
let timer = null;
let selectedCard = null;   // {stage:'D'|'E'|'M'|'W', cycle:<latest>} for signal inspector
let selectedTLCell = null; // {cycle, instrId} for a pinned explanation
let explainLog = [];       // rolling feed of {cycle, text}
let currentExampleKey = 'load-use';
let maxCycleSeen = 0;      // furthest cycle reached since the last reset, for the "rewound" banner
let regHistoryOpen = false;

const el = id => document.getElementById(id);

// ================= assemble / reset =================
function doAssemble(showErrors){
  const src = el('source').value;
  asm = assemble(src);
  const statusEl = el('asm-status');
  if (asm.errors.length){
    statusEl.innerHTML = '<div class="asm-errors">'+asm.errors.map(e=>escapeHtml(e)).join('\n')+'</div>';
  } else {
    statusEl.innerHTML = '<div class="asm-ok">Assembled '+asm.order.length+' instruction'+(asm.order.length===1?'':'s')+'.</div>';
  }
  resetMachine();
}

function resetMachine(){
  if (!asm || asm.errors.length){ machine = null; renderAll(); return; }
  machine = new Machine(asm, opts);
  explainLog = [];
  selectedCard = null;
  selectedTLCell = null;
  maxCycleSeen = 0;
  pause();
  renderAll();
}

function rebuildExplainLog(){
  explainLog = [];
  for (const h of machine.history){
    for (const line of h.log) explainLog.push({cycle:h.cycle, text:line});
    explainLog.push({cycle:h.cycle, text: synthesizeCycleSummary(h)});
  }
  if (explainLog.length>400) explainLog = explainLog.slice(-400);
}

function stepOnce(){
  if (!machine || machine.finished) { pause(); return; }
  machine.step();
  const last = machine.history[machine.history.length-1];
  for (const line of last.log) explainLog.push({cycle:last.cycle, text:line});
  explainLog.push({cycle:last.cycle, text: synthesizeCycleSummary(last)});
  if (explainLog.length>400) explainLog = explainLog.slice(-400);
  if (machine.finished) pause();
  maxCycleSeen = Math.max(maxCycleSeen, machine.cycle);
  renderAll();
}

// Deterministic "time travel": re-simulate from scratch up to cycle n. Since the simulator
// has no randomness, this always reproduces exactly what was there before - it's a real
// rewind, not a snapshot restore, and stepping/running forward again from here continues
// identically to the original run.
function goToCycle(n){
  if (!asm || asm.errors.length) return;
  pause();
  n = Math.max(0, n|0);
  const m = new Machine(asm, opts);
  for (let i=0;i<n && !m.finished;i++) m.step();
  machine = m;
  rebuildExplainLog();
  selectedTLCell = null;
  renderAll();
}

function synthesizeCycleSummary(s){
  const parts = [];
  const nameOf = st => (st && !st.bubble) ? (st.text||ICODE_NAMES[st.icode]) : null;
  if (nameOf(s.W)) parts.push('“'+s.W.text+'” retires (write-back)');
  if (s.decode && s.decode.forwardedA) parts.push('operand forwarded from '+s.decode.forwardedA);
  if (s.decode && s.decode.forwardedB) parts.push('operand forwarded from '+s.decode.forwardedB);
  if (parts.length===0) return 'Cycle '+s.cycle+': pipeline advances.';
  return 'Cycle '+s.cycle+': '+parts.join('; ')+'.';
}

function run(){
  if (!machine || machine.finished) return;
  running = true;
  renderControls();
  const speed = parseInt(el('speed').value,10);
  const ms = Math.max(30, 650 - speed*60);
  clearInterval(timer);
  timer = setInterval(()=>{
    if (!machine || machine.finished){ pause(); return; }
    stepOnce();
  }, ms);
}
function pause(){
  running = false;
  clearInterval(timer);
  timer = null;
  renderControls();
}

// ================= helpers =================
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function hex(v, digits){ digits=digits||8; const u = (v>>>0); return '0x'+u.toString(16).padStart(digits,'0'); }
function stageColorVar(letter){
  return { F:'var(--blue)', D:'var(--accent)', E:'var(--amber)', M:'var(--violet)', W:'var(--green)' }[letter];
}
function idBadge(id){ return id!=null ? ('I'+id) : ''; }

function peekFetch(){
  if (!machine) return null;
  if (machine.fetchHalted) return null;
  return machine.fetchAt(machine.pc);
}

// ================= rendering =================
function renderAll(){
  renderControls();
  renderStatusStrip();
  renderCycleNav();
  renderPipeline();
  renderExplain();
  renderTimeline();
  renderRegs();
  renderMem();
  renderSignals();
  renderPerf();
}

function renderCycleNav(){
  const banner = el('viewing-banner');
  const jump = el('cyc-jump');
  if (!machine){
    if (banner) banner.classList.remove('show');
    return;
  }
  if (jump && document.activeElement !== jump) jump.value = machine.cycle;
  if (jump) jump.max = Math.max(maxCycleSeen, machine.cycle);
  if (banner){
    if (machine.cycle < maxCycleSeen){
      banner.classList.add('show');
      banner.textContent = 'Rewound to cycle '+machine.cycle+' of '+maxCycleSeen+' reached so far - Step/Run will re-simulate forward from here (deterministically identical to before).';
    } else {
      banner.classList.remove('show');
    }
  }
}

function renderControls(){
  const hasMachine = !!machine;
  el('btn-step').disabled = !hasMachine || (machine && machine.finished);
  el('btn-run').disabled = !hasMachine || (machine && machine.finished);
  el('btn-run').textContent = running ? 'Pause ❚❚' : 'Run ▶';
  el('btn-reset').disabled = !hasMachine;
}

function renderStatusStrip(){
  const s = el('status-strip');
  if (!machine){ s.innerHTML = '<span class="stat">Assemble a program to begin.</span>'; return; }
  let pill = '<span class="status-pill pill-aok">RUNNING</span>';
  if (machine.finished){
    if (machine.finishReason==='halt') pill = '<span class="status-pill pill-halt">HALTED</span>';
    else pill = '<span class="status-pill pill-err">'+(machine.finishReason||'STOPPED').toUpperCase()+'</span>';
  }
  s.innerHTML = [
    pill,
    '<span class="stat">Cycle <b>'+machine.cycle+'</b></span>',
    '<span class="stat">PC <b>'+hex(machine.pc)+'</b></span>',
    '<span class="stat">Retired <b>'+machine.stats.instrRetired+'</b></span>',
    '<span class="stat">Bubbles <b>'+machine.stats.bubblesInserted+'</b></span>',
    '<span class="stat">Load-use stalls <b>'+machine.stats.loadUseStalls+'</b></span>',
    '<span class="stat">RET stalls <b>'+machine.stats.retStalls+'</b></span>',
    '<span class="stat">Mispredicts <b>'+machine.stats.mispredicts+'</b></span>',
  ].join('');
}

function stageCardHtml(stage, occupant, extra){
  extra = extra || {};
  if (!occupant || (occupant.bubble)){
    return '<div class="instr-card bubble" data-stage="'+stage+'">'+
      '<div class="instr-empty">'+(extra.emptyLabel||'bubble')+'</div>'+
      (extra.badges? '<div class="badge-row">'+extra.badges+'</div>' : '') +
      '</div>';
  }
  const flushed = extra.flushed ? ' flushed' : '';
  const sel = (selectedCard && selectedCard.stage===stage) ? ' selected' : '';
  return '<div class="instr-card'+flushed+sel+'" data-stage="'+stage+'">'+
    '<span class="instr-id">'+idBadge(occupant.id)+'</span>'+
    '<div class="instr-text">'+escapeHtml(occupant.text||ICODE_NAMES[occupant.icode]||'?')+'</div>'+
    (extra.badges? '<div class="badge-row">'+extra.badges+'</div>' : '')+
    '</div>';
}

function renderPipeline(){
  const wrap = el('pipeline');
  if (!machine){
    wrap.innerHTML = '<div style="color:var(--text-faint);padding:20px;">No program loaded yet.</div>';
    return;
  }
  const last = machine.history[machine.history.length-1] || null;
  const f = peekFetch();
  const fOccupant = (f && f.icode!==ICODE.INVALID) ? { id:null, text:f.text } : (f? {id:null,text:'<invalid opcode>'}:null);

  let fBadges = '';
  if (last && last.mispredict) fBadges += '<span class="badge badge-flush">redirected</span>';
  if (machine.fetchHalted) fBadges = '<span class="badge badge-halt">halted</span>';

  let dBadges = '';
  if (last && last.loadUseHazard) dBadges += '<span class="badge badge-stall">stalled (load-use)</span>';
  if (last && last.retInFlight) dBadges += '<span class="badge badge-stall">waiting on RET</span>';

  let eBadges = '';
  if (last && (last.loadUseHazard||last.mispredict) && machine.E.bubble) eBadges += '<span class="badge badge-flush">bubble</span>';
  if (last && last.decode && (last.decode.forwardedA || last.decode.forwardedB) && !machine.E.bubble){
    eBadges += '<span class="badge badge-fwd">forwarded</span>';
  }

  const cols = [
    { letter:'F', label:'FETCH', html: (function(){
        if (!f) return stageCardHtml('F', null, {emptyLabel: machine.fetchHalted?'no more fetches':'stalled', badges:fBadges});
        return stageCardHtml('F', fOccupant, {badges:fBadges});
      })() },
    { letter:'D', label:'DECODE', html: stageCardHtml('D', machine.D, {badges:dBadges}) },
    { letter:'E', label:'EXECUTE', html: stageCardHtml('E', machine.E, {badges:eBadges}) },
    { letter:'M', label:'MEMORY', html: stageCardHtml('M', machine.M, {}) },
    { letter:'W', label:'WRITE BACK', html: stageCardHtml('W', machine.W, {}) },
  ];

  let out = '';
  cols.forEach((c,i)=>{
    out += '<div class="stage-col">'+
      '<div class="stage-label"><span class="stage-dot" style="background:'+stageColorVar(c.letter)+'"></span>'+c.label+'</div>'+
      c.html+
      '</div>';
    if (i<cols.length-1) out += '<div class="arrow-row">→</div>';
  });
  wrap.innerHTML = out;

  wrap.querySelectorAll('.instr-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      const stage = card.getAttribute('data-stage');
      selectedCard = { stage };
      document.querySelector('.tab[data-tab="sig"]').click();
      renderPipeline();
      renderSignals();
    });
  });
}

function renderExplain(){
  const box = el('explain');
  if (!machine || explainLog.length===0){
    box.innerHTML = '<div class="explain-empty">Step the simulator to see a cycle-by-cycle explanation here.</div>';
    return;
  }
  const recent = explainLog.slice(-12);
  box.innerHTML = recent.map(l=>'<div class="explain-line"><span class="dot">●</span><span>'+escapeHtml(l.text)+'</span></div>').join('');
  box.scrollTop = box.scrollHeight;
}

function renderTimeline(){
  const table = el('timeline');
  if (!machine || machine.history.length===0){
    table.innerHTML = '';
    return;
  }
  // gather instructions that have appeared in F at least once, in program order of first appearance
  const rows = new Map(); // id -> text
  for (const h of machine.history){
    if (h.F && h.F.id!=null && !rows.has(h.F.id)) rows.set(h.F.id, h.F.text);
  }
  const ids = Array.from(rows.keys());
  const nCycles = machine.history.length;

  let thead = '<tr><th style="text-align:left;position:sticky;left:0;background:var(--bg);">instr</th>';
  for (let c=1;c<=nCycles;c++) thead += '<th>'+c+'</th>';
  thead += '</tr>';

  let body = '';
  for (const id of ids){
    body += '<tr><td class="row-head">I'+id+' <span style="color:var(--text-faint);">'+escapeHtml(rows.get(id))+'</span></td>';
    for (let c=1;c<=nCycles;c++){
      const h = machine.history[c-1];
      let letter = null;
      if (h.F && h.F.id===id) letter='F';
      else if (h.D && !h.D.bubble && h.D.id===id) letter='D';
      else if (h.E && !h.E.bubble && h.E.id===id) letter='E';
      else if (h.M && !h.M.bubble && h.M.id===id) letter='M';
      else if (h.W && !h.W.bubble && h.W.id===id) letter='W';
      if (letter){
        body += '<td><div class="tl-cell tl-'+letter+'" data-cycle="'+c+'" data-id="'+id+'">'+letter+'</div></td>';
      } else {
        body += '<td></td>';
      }
    }
    body += '</tr>';
  }
  table.innerHTML = thead+body;
  table.querySelectorAll('.tl-cell').forEach(cell=>{
    cell.addEventListener('click', ()=>{
      const cycle = parseInt(cell.getAttribute('data-cycle'),10);
      selectedTLCell = { cycle };
      document.querySelector('.tab[data-tab="sig"]').click();
      renderSignals();
    });
  });
}

function renderRegs(){
  const panel = el('panel-regs');
  if (!machine){
    panel.innerHTML = '<div class="sig-empty">No program loaded.</div>';
    return;
  }
  const last = machine.history[machine.history.length-1];
  const prevRegs = last ? (machine.history[machine.history.length-2] ? machine.history[machine.history.length-2].regsAfter : new Array(8).fill(0)) : null;
  let rows = '';
  for (let i=0;i<8;i++){
    const v = machine.regs[i];
    const changed = last && prevRegs && prevRegs[i]!==v;
    rows += '<tr class="'+(changed?'changed':'')+'"><td class="rname">%'+REG_SHORT[i]+'</td><td class="rval">'+v+'</td><td class="rval mono" style="color:var(--text-faint);">'+hex(v)+'</td></tr>';
  }
  const cc = machine.cc;
  panel.innerHTML =
    '<table class="regs">'+rows+'</table>'+
    '<div class="cc-row">'+
      '<div class="cc-flag '+(cc.ZF?'on':'')+'"><div class="cc-name">ZF</div><div class="cc-val">'+cc.ZF+'</div></div>'+
      '<div class="cc-flag '+(cc.SF?'on':'')+'"><div class="cc-name">SF</div><div class="cc-val">'+cc.SF+'</div></div>'+
      '<div class="cc-flag '+(cc.OF?'on':'')+'"><div class="cc-name">OF</div><div class="cc-val">'+cc.OF+'</div></div>'+
    '</div>'+
    '<div class="tip" style="margin-top:14px;">Condition codes are only updated by <code>OPl</code> instructions (add/sub/and/xor). A branch a couple of cycles later just reads whatever is currently sitting in this register - no forwarding needed, since it is a single global piece of state, not something carried in a pipeline register.</div>'+
    '<div class="reg-hist-toggle" id="reg-hist-toggle">'+(regHistoryOpen?'▾':'▸')+' value history, cycle by cycle</div>'+
    '<div id="reg-hist-body"></div>';
  el('reg-hist-toggle').addEventListener('click', ()=>{ regHistoryOpen = !regHistoryOpen; renderRegs(); });
  if (regHistoryOpen) renderRegHistory();
}

function renderRegHistory(){
  const body = el('reg-hist-body');
  if (!body || !machine || machine.history.length===0){
    if (body) body.innerHTML = '<div class="sig-empty">Step the simulator to build up history.</div>';
    return;
  }
  const span = machine.history.slice(-14); // last 14 cycles fit comfortably in a 340px column
  let thead = '<tr><th style="text-align:left;">reg</th>'+span.map(h=>'<th>'+h.cycle+'</th>').join('')+'</tr>';
  let rows = '';
  for (let i=0;i<8;i++){
    rows += '<tr><td class="rn">%'+REG_SHORT[i]+'</td>';
    for (let c=0;c<span.length;c++){
      const v = span[c].regsAfter[i];
      const prev = c>0 ? span[c-1].regsAfter[i] : (machine.history[machine.history.length-1-span.length]? machine.history[machine.history.length-1-span.length].regsAfter[i] : v);
      const changed = v!==prev;
      rows += '<td class="'+(changed?'changed':'')+'">'+v+'</td>';
    }
    rows += '</tr>';
  }
  body.innerHTML = '<div style="overflow-x:auto;"><table class="reghist">'+thead+rows+'</table></div>'+
    '<p style="color:var(--text-faint);font-size:11px;margin:8px 0 0;">Each column is the register file right after that cycle\u2019s write-back. A value can only change on a cycle where some instruction actually retires into that register.</p>';
}

let memBaseAddr = 0;
function renderMem(){
  const panel = el('panel-mem');
  if (!machine){
    panel.innerHTML = '<div class="sig-empty">No program loaded.</div>';
    return;
  }
  panel.innerHTML =
    '<div class="mem-controls"><span class="field-label">From</span><input type="text" id="mem-addr" value="'+hex(memBaseAddr)+'"><button class="btn" id="mem-esp" style="padding:5px 8px;">near %esp</button></div>'+
    '<table class="mem" id="mem-table"></table>';
  el('mem-addr').addEventListener('change', (e)=>{
    let v = e.target.value.trim();
    let n = v.startsWith('0x') ? parseInt(v,16) : parseInt(v,10);
    if (isNaN(n)) n = 0;
    memBaseAddr = Math.max(0, Math.min(MEM_SIZE-4, n - (n%4)));
    renderMemTable();
  });
  el('mem-esp').addEventListener('click', ()=>{
    const espVal = machine.regs[REG.ESP] >>> 0;
    memBaseAddr = Math.max(0, (espVal - 16) - ((espVal-16)%4));
    el('mem-addr').value = hex(memBaseAddr);
    renderMemTable();
  });
  renderMemTable();
}
function renderMemTable(){
  const tbl = el('mem-table');
  if (!tbl || !machine) return;
  const espVal = machine.regs[REG.ESP]>>>0;
  let rows = '';
  for (let i=0;i<16;i++){
    const addr = memBaseAddr + i*4;
    if (addr+4>MEM_SIZE) break;
    const r = readWord(machine.mem, addr);
    const isEsp = addr===espVal;
    const meta = machine.instrAt.get(addr);
    rows += '<tr class="'+(isEsp?'esp':'')+'"><td class="addr">'+hex(addr)+'</td><td>'+r.value+'</td><td style="color:var(--text-faint);">'+hex(r.value)+'</td><td style="color:var(--text-faint);">'+(meta?escapeHtml(meta.text):'')+(isEsp?' <span style="color:var(--amber);">← esp</span>':'')+'</td></tr>';
  }
  tbl.innerHTML = rows;
}

function fieldRow(name, value){
  return '<div class="sig-row"><span>'+name+'</span><b>'+value+'</b></div>';
}
function regName(r){ return r===REG.NONE ? 'none' : '%'+REG_SHORT[r]; }

function renderSignals(){
  const panel = el('signals-content');
  if (!machine){
    panel.innerHTML = '<div class="sig-empty">No program loaded.</div>';
    return;
  }
  let h;
  if (selectedTLCell){
    h = machine.history[selectedTLCell.cycle-1];
  } else {
    h = machine.history[machine.history.length-1];
  }
  if (!h){
    panel.innerHTML = '<div class="sig-empty">Step the simulator, then click a pipeline card or a timeline cell to inspect its signals here.</div>';
    return;
  }

  function stageBlock(letter, label, reg, extraRows){
    const empty = !reg || reg.bubble;
    let body;
    if (empty){
      body = '<div class="sig-empty">bubble - no instruction here this cycle</div>';
    } else {
      body = '<div class="sig-body">'+
        fieldRow('instr', escapeHtml(reg.text||ICODE_NAMES[reg.icode]))+
        fieldRow('icode', ICODE_NAMES[reg.icode])+
        (extraRows||'')+
        '</div>';
    }
    return '<div class="sig-stage"><div class="sig-head" style="background:color-mix(in srgb, '+stageColorVar(letter)+' 16%, transparent);color:'+stageColorVar(letter)+';">'+
      '<span class="stage-dot" style="background:'+stageColorVar(letter)+'"></span>'+label+'</div>'+body+'</div>';
  }

  let out = '';
  out += stageBlock('D','DECODE (D register, entering this cycle)', h.D,
    h.D && !h.D.bubble ? (fieldRow('valC', h.D.valC)+fieldRow('valP', hex(h.D.valP))) : '');

  const dec = h.decode;
  let decodeExtra = '';
  if (dec && h.D && !h.D.bubble){
    decodeExtra =
      fieldRow('srcA', regName(dec.srcA))+
      fieldRow('srcB', regName(dec.srcB))+
      fieldRow('dstE', regName(dec.dstE))+
      fieldRow('dstM', regName(dec.dstM))+
      fieldRow('valA', dec.valA + (dec.forwardedA? ' <span style="color:var(--violet);">('+dec.forwardedA+')</span>' : ''))+
      fieldRow('valB', dec.valB + (dec.forwardedB? ' <span style="color:var(--violet);">('+dec.forwardedB+')</span>' : ''));
  }
  out += '<div class="sig-stage"><div class="sig-head" style="color:var(--text-dim);">Decode logic output this cycle</div>'+
    (decodeExtra ? '<div class="sig-body">'+decodeExtra+'</div>' : '<div class="sig-empty">nothing decoded (D was empty)</div>')+'</div>';

  out += stageBlock('E','EXECUTE (E register, entering this cycle)', h.E,
    h.E && !h.E.bubble ? (fieldRow('valA', h.E.valA)+fieldRow('valB', h.E.valB)+fieldRow('dstE', regName(h.E.dstE))+fieldRow('dstM', regName(h.E.dstM))) : '');
  if (h.execute && h.E && !h.E.bubble){
    out += '<div class="sig-stage"><div class="sig-head" style="color:var(--text-dim);">ALU output this cycle</div><div class="sig-body">'+
      fieldRow('valE', h.execute.valE)+
      (h.E.icode===ICODE.JXX ? fieldRow('Cnd', h.execute.Cnd?'true (taken)':'false (not taken)') : '')+
      '</div></div>';
  }

  out += stageBlock('M','MEMORY (M register, entering this cycle)', h.M,
    h.M && !h.M.bubble ? (fieldRow('valE (address)', hex(h.M.valE))+fieldRow('valA (store value)', h.M.valA)+fieldRow('dstE', regName(h.M.dstE))+fieldRow('dstM', regName(h.M.dstM))) : '');
  if (h.memory && h.M && !h.M.bubble && (h.M.icode===ICODE.MRMOVL||h.M.icode===ICODE.POPL||h.M.icode===ICODE.RET)){
    out += '<div class="sig-stage"><div class="sig-head" style="color:var(--text-dim);">Memory read result</div><div class="sig-body">'+fieldRow('valM', h.memory.valM)+'</div></div>';
  }

  out += stageBlock('W','WRITE BACK (W register, entering this cycle)', h.W,
    h.W && !h.W.bubble ? (fieldRow('valE', h.W.valE)+fieldRow('valM', h.W.valM)+fieldRow('dstE', regName(h.W.dstE))+fieldRow('dstM', regName(h.W.dstM))) : '');

  if (h.loadUseHazard || h.retInFlight || h.mispredict){
    let notes = '';
    if (h.loadUseHazard) notes += '<div class="sig-row" style="color:var(--amber);">⚠ load-use hazard: Decode needed a register Execute (a load) has not produced yet</div>';
    if (h.retInFlight) notes += '<div class="sig-row" style="color:var(--amber);">⚠ RET in flight: next PC unknown until it reaches Write-back</div>';
    if (h.mispredict) notes += '<div class="sig-row" style="color:var(--danger);">⚠ branch mispredicted: flushing 2 wrong-path instructions</div>';
    out = '<div class="sig-stage"><div class="sig-head" style="color:var(--amber);">Hazards this cycle</div><div class="sig-body">'+notes+'</div></div>' + out;
  }

  panel.innerHTML = '<div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;">Cycle '+h.cycle+(selectedTLCell?' (pinned - click a timeline cell to change)':' (latest)')+'</div>' + out;
}

function compareCycles(a, b){
  const box = el('cmp-result');
  if (!machine || !box) return;
  const max = machine.history.length;
  if (a<1 || b<1 || a>max || b>max){
    box.innerHTML = '<div class="sig-empty">Both cycles must be between 1 and '+max+' (the furthest this run has reached). Step or run further first.</div>';
    return;
  }
  const ha = machine.history[a-1], hb = machine.history[b-1];
  const lines = [];
  for (let i=0;i<8;i++){
    if (ha.regsAfter[i] !== hb.regsAfter[i]){
      lines.push('<div class="cmp-line">%'+REG_SHORT[i]+': <b>'+ha.regsAfter[i]+'</b> \u2192 <b>'+hb.regsAfter[i]+'</b></div>');
    }
  }
  const stageAt = (h, letter) => {
    const reg = {F:null, D:h.D, E:h.E, M:h.M, W:h.W}[letter];
    if (letter==='F') return h.F ? ('I'+h.F.id) : '\u2014';
    return (reg && !reg.bubble) ? ('I'+reg.id+' '+(reg.text||'')) : 'bubble';
  };
  const stageLines = ['F','D','E','M','W'].map(l=>{
    const va = stageAt(ha,l), vb = stageAt(hb,l);
    return va===vb ? '' : '<div class="cmp-line">'+l+': <b>'+escapeHtml(va)+'</b> \u2192 <b>'+escapeHtml(vb)+'</b></div>';
  }).filter(Boolean);
  const events = [];
  if (!ha.mispredict && hb.mispredict) events.push('a branch misprediction occurred by cycle '+b);
  if (!ha.loadUseHazard && hb.loadUseHazard) events.push('a load-use stall occurred by cycle '+b);
  if (ha.cc && hb.cc && (ha.cc.ZF!==hb.cc.ZF||ha.cc.SF!==hb.cc.SF||ha.cc.OF!==hb.cc.OF)) events.push('condition codes changed');

  let html = '';
  if (lines.length===0 && stageLines.length===0 && events.length===0){
    html = '<div class="sig-empty">No visible difference in registers or stage occupancy between these two cycles.</div>';
  } else {
    if (lines.length) html += '<div class="misc-label">REGISTER CHANGES</div>'+lines.join('');
    if (stageLines.length) html += '<div class="misc-label" style="margin-top:8px;">STAGE CONTENTS CHANGED</div>'+stageLines.join('');
    if (events.length) html += '<div class="misc-label" style="margin-top:8px;">NOTABLE EVENTS</div><div class="cmp-line">'+events.join('; ')+'</div>';
  }
  box.innerHTML = html;
}

// ================= Learn tab: concepts + misconceptions + quiz =================
const CONCEPTS_HTML = `
<div class="guide">
<h4>Latency vs. throughput</h4>
<p><b>Latency</b> is how long one instruction takes start-to-finish (5 cycles here, always). <b>Throughput</b> is how many instructions finish per cycle once the pipeline is full - ideally 1 per cycle. Pipelining never makes a single instruction faster; it lets five of them be in flight at once.</p>

<h4>Why pipeline registers exist</h4>
<p>Each of D/E/M/W is real state, clocked once per cycle, that carries an instruction's <em>entire</em> context forward - not just a value, but which register it's destined for (<code>dstE</code>/<code>dstM</code>), its status, its opcode. If a value and its destination register ever became separated, the wrong register could receive it. Try the "buggy mode" scenario with forwarding off.</p>

<h4>Hazard taxonomy</h4>
<p><b>Data hazard</b>: an instruction needs a value that a nearby instruction hasn't produced yet (this simulator implements the RAW case, the one an in-order 5-stage pipeline actually hits). <b>Control hazard</b>: we don't know the next instruction to fetch (branches, ret). <b>Structural hazard</b>: two instructions want the same hardware resource at once - not really visible in this simple pipeline. RAW (read-after-write) is what you'll see here; WAR and WAW only become possible once instructions can finish out of order, which this in-order pipeline never allows.</p>

<h4>Stall vs. bubble - not the same thing</h4>
<p>A <b>stall</b> freezes a pipeline register in place (it re-latches its own old value instead of accepting new input). A <b>bubble</b> is what gets injected into the stage <em>ahead</em> of the stall - an empty, harmless instruction slot. A load-use hazard stalls F and D while bubbling E.</p>

<h4>Forwarding paths in this simulator</h4>
<p>Decode can pull an operand from: the ALU result currently being computed in Execute, an ALU result passing through Memory, a load result just completed in Memory, or anything sitting in Write-back this cycle - in that priority order - before falling back to the register file (which only reflects writes from cycles already completed).</p>

<h4>Branches here: predict-not-taken</h4>
<p>Fetch always guesses "not taken" and keeps going straight through. The real outcome isn't known until the branch reaches Execute, one cycle after the following instruction was already fetched into Decode. If we guessed wrong, both of those wrong-path instructions are flushed - a 2-cycle misprediction penalty.</p>

<h4>Why RET is awkward</h4>
<p>Every other instruction's next PC is either "the next address" or "a target written right into the instruction." RET's target lives in <em>memory</em>, at an address (the stack pointer) that itself isn't finalized until Memory. Nothing downstream of RET can be safely fetched until RET's return address has actually been written back - hence 3 bubble cycles.</p>

<h4>Beyond this simulator</h4>
<p>Real CPUs go further: multiple instructions issued per cycle (superscalar), instructions completing out of order with register renaming and reorder buffers (Tomasulo-style scheduling), dynamic branch predictors that learn from history, and speculative execution that can run wrong-path work and later discard it. None of that changes the fundamental hazard: something can't be used before it exists.</p>
</div>`;

const MISCONCEPTIONS = [
  { wrong:'Pipelining makes every individual instruction run faster.',
    right:'Each instruction still takes 5 cycles start to finish - if anything, slightly worse than an unpipelined design once you add register overhead. What improves is throughput: how many instructions finish per cycle once the pipe is full.',
    example:'Run the "Independent instructions" scenario: I1 still takes cycles 1-5. What is new is that I2 and I3 are already underway before I1 finishes.' },
  { wrong:'Throughput and latency are basically the same thing.',
    right:'Latency is a per-instruction duration; throughput is a rate across many instructions. A pipeline with mediocre per-instruction latency can still have excellent throughput.',
    example:'Open the Performance tab: latency stays fixed at 5 times the clock period no matter how many instructions you run, while throughput approaches 1 divided by the clock period.' },
  { wrong:'If a value has reached a register\u2019s input, it is already stored there.',
    right:'A register only captures its input at the rising clock edge. Right up until that edge, the input can still be changing - what matters is what value was present the instant the clock ticked.',
    example:'This is why pipeline registers update all at once, together, rather than a stage "leaking" into the next one mid-cycle.' },
  { wrong:'Any dependency between two instructions is automatically a hazard.',
    right:'A dependency only becomes a hazard if the timing would actually cause the consumer to read a value before the producer supplies it. Enough distance (or forwarding) can make a real dependency completely harmless.',
    example:'"Dependency with a safe gap" has a real dependency (I4 needs edx from I1) but no hazard at all - I1 has already written back by the time I4 decodes.' },
  { wrong:'Every hazard requires a stall.',
    right:'Most data hazards in this pipeline are resolved by forwarding, with zero lost cycles. Only the load-use hazard forces a real stall, because the loaded value simply does not exist yet anywhere forwarding can reach.',
    example:'Compare "ALU-to-ALU forwarding" (zero stalls) against "Load-use hazard" (exactly one stall).' },
  { wrong:'Forwarding can fix every hazard, including loads.',
    right:'Forwarding moves a value that already exists to where it is needed early. It cannot forward a value from memory before memory has actually been read. That is precisely why the load-use hazard needs a stall instead.',
    example:'Turn off "Stalls" on the load-use scenario and watch the consumer silently pick up a stale register-file value instead.' },
  { wrong:'dstE is a value, and valE is a register name.',
    right:'It is the other way around: dstE names WHICH register a value should land in; valE IS the value itself. They travel together through the pipeline precisely so they never get mixed up.',
    example:'Open the Signals tab on any instruction with a destination register and look at the Execute block: valE is the computed number, dstE is the register slot it is headed for.' },
  { wrong:'Branch prediction determines whether a program is correct.',
    right:'Prediction only affects performance (how many cycles get wasted). The pipeline always produces the architecturally correct result eventually, by flushing and re-fetching when a prediction turns out wrong.',
    example:'"Branch misprediction + flush" still ends with exactly the right register values - it just took 2 extra cycles to get there.' },
  { wrong:'More pipeline stages is automatically a better design.',
    right:'More (shallower) stages can raise the clock frequency, but each extra stage also adds register overhead and more opportunities for hazards and stalls. Real designs balance stage count against those costs - depth is a trade-off, not a free win.',
    example:'In the Performance tab, push register overhead up and watch a deeper, more finely-sliced pipeline stop paying for itself.' },
];

function renderMisconceptions(){
  return '<h4 style="margin-top:18px;">Common misconceptions</h4>' +
    '<p style="color:var(--text-faint);">Click one to check yourself before reading the correction.</p>' +
    MISCONCEPTIONS.map(function(m){
      return '<details class="misc-item"><summary>'+escapeHtml(m.wrong)+'</summary>'+
      '<div class="misc-body">'+
        '<div class="misc-label">ACTUALLY</div>'+
        '<div class="ok">'+escapeHtml(m.right)+'</div>'+
        '<div class="ex">'+escapeHtml(m.example)+'</div>'+
      '</div></details>';
    }).join('');
}

const QUIZ = [
  { concept:'throughput', prompt:'A 5-stage pipeline is running at full speed with no hazards. Roughly how many instructions complete per clock cycle?',
    options:['5','1','0.2','It depends only on program length'], correct:1,
    explain:'Once full, an ideal pipeline retires one instruction per cycle - that is the whole point of overlapping the 5 stages.' },
  { concept:'stall-vs-bubble', prompt:'During a load-use stall, what happens to the instruction sitting in Decode?',
    options:['It is discarded permanently','It is frozen in place and decoded again next cycle','It jumps ahead into Execute anyway','It is converted into a bubble'], correct:1,
    explain:'A stall holds the pipeline register in place - the same instruction is still in Decode next cycle, now with the data it needed available via forwarding.' },
  { concept:'forwarding', prompt:'Which of these can forwarding NOT fix by itself?',
    options:['Two back-to-back addl instructions','A rrmovl feeding an addl right after it','A mrmovl (load) feeding an addl on the very next instruction','An irmovl feeding an addl two instructions later'], correct:2,
    explain:'The loaded value literally does not exist until Memory finishes - there is nothing yet to forward at Decode time, so a stall is unavoidable for one cycle.' },
  { concept:'branches', prompt:'This simulator predicts branches as "not taken." What happens when a branch actually IS taken?',
    options:['The program crashes','Two already-fetched instructions are flushed and fetch restarts at the target','Nothing - not-taken is always correct','The branch instruction is skipped'], correct:1,
    explain:'By the time the branch resolves in Execute, two more instructions were speculatively fetched along the wrong path and must be discarded.' },
  { concept:'dest-ids', prompt:'Why does a pipeline register carry a destination register ID (dstE) alongside the computed value (valE)?',
    options:['To save wiring','Purely for the visualization/debugger','So the value stays correctly paired with where it belongs all the way to write-back','Because the ALU requires it as an input'], correct:2,
    explain:'If the value and its destination register were not kept together, a later instruction could accidentally receive an earlier instruction\u2019s result.' },
];

function loadMistakeTally(){
  try{ return JSON.parse(localStorage.getItem('y86lab_quiz_mistakes')||'{}'); } catch(e){ return {}; }
}
function bumpMistake(concept){
  try{
    const t = loadMistakeTally();
    t[concept] = (t[concept]||0) + 1;
    localStorage.setItem('y86lab_quiz_mistakes', JSON.stringify(t));
  } catch(e){ /* storage unavailable - quiz still works, just without the review nudge */ }
}
function renderQuiz(){
  const tally = loadMistakeTally();
  const reviewConcepts = Object.keys(tally).filter(function(c){ return tally[c]>=2; });
  let out = '<h4 style="margin-top:18px;">Quick check</h4>';
  if (reviewConcepts.length){
    out += '<div class="quiz-review">You have missed questions about <b>'+reviewConcepts.join(', ')+'</b> more than once - worth a re-read above before you answer.</div>';
  }
  QUIZ.forEach(function(q, qi){
    out += '<div class="quiz-q" data-qi="'+qi+'"><div class="qtext">'+(qi+1)+'. '+escapeHtml(q.prompt)+'</div>';
    q.options.forEach(function(opt, oi){
      out += '<label class="quiz-opt"><input type="radio" name="quiz-'+qi+'" value="'+oi+'"> '+escapeHtml(opt)+'</label>';
    });
    out += '<div><button class="btn" style="margin-top:8px;padding:5px 10px;font-size:11.5px;" data-check="'+qi+'">Check answer</button></div>';
    out += '<div class="quiz-feedback" id="quiz-fb-'+qi+'"></div>';
    out += '</div>';
  });
  return out;
}
function wireQuiz(){
  document.querySelectorAll('[data-check]').forEach(function(btn){
    btn.addEventListener('click', function(){
      const qi = parseInt(btn.getAttribute('data-check'),10);
      const q = QUIZ[qi];
      const chosen = document.querySelector('input[name="quiz-'+qi+'"]:checked');
      const fb = el('quiz-fb-'+qi);
      if (!chosen){ fb.className='quiz-feedback incorrect'; fb.style.display='block'; fb.textContent='Pick an answer first.'; return; }
      const val = parseInt(chosen.value,10);
      if (val===q.correct){
        fb.className='quiz-feedback correct';
        fb.textContent='Correct. '+q.explain;
      } else {
        fb.className='quiz-feedback incorrect';
        fb.textContent='Not quite. '+q.explain;
        bumpMistake(q.concept);
      }
    });
  });
}
function renderGuideTab(){
  const panel = el('panel-guide');
  panel.innerHTML = CONCEPTS_HTML + '<div class="guide">' + renderMisconceptions() + renderQuiz() + '</div>';
  wireQuiz();
}

// ================= Performance lab =================
let stageDelays = { F:60, D:50, E:90, M:80, W:40 };
let regOverhead = 20;
let classicABC = { A:50, B:150, C:100, ov:20 };

function computeClock(delays, overhead){
  const vals = Object.keys(delays).map(function(k){ return delays[k]; });
  const maxD = Math.max.apply(null, vals);
  const sumD = vals.reduce(function(a,b){ return a+b; }, 0);
  const pipeClock = maxD + overhead;
  const seqClock = sumD + overhead;
  return { pipeClock:pipeClock, seqClock:seqClock, pipeGIPS: 1000/pipeClock, seqGIPS: 1000/seqClock };
}

function barHtml(label, widthPct, text, cls){
  return '<div class="bar-row"><div class="bar-label">'+label+'</div><div class="bar-track"><div class="bar-fill '+cls+'" style="width:'+Math.max(4,widthPct)+'%;">'+text+'</div></div></div>';
}

function renderPerf(){
  const panel = el('panel-perf');
  if (!panel) return;

  const c = computeClock({A:classicABC.A,B:classicABC.B,C:classicABC.C}, classicABC.ov);
  let out = '<div class="perf-block"><h4>Classic non-uniform pipeline (3 stages)</h4>'+
    '<p style="color:var(--text-dim);font-size:12px;margin-top:0;">The clock period is set by the SLOWEST stage, not the average. Drag the numbers and watch the bottleneck move.</p>'+
    '<div class="preset-row">'+
      '<button class="btn" data-preset="unbalanced">Unbalanced 50/150/100</button>'+
      '<button class="btn" data-preset="balanced">Balanced 100/100/100</button>'+
    '</div>'+
    '<div class="stage-inputs">'+
      '<label>A (ps)<input type="number" id="abc-a" value="'+classicABC.A+'" min="1"></label>'+
      '<label>B (ps)<input type="number" id="abc-b" value="'+classicABC.B+'" min="1"></label>'+
      '<label>C (ps)<input type="number" id="abc-c" value="'+classicABC.C+'" min="1"></label>'+
      '<label>reg. overhead (ps)<input type="number" id="abc-ov" value="'+classicABC.ov+'" min="0"></label>'+
    '</div>'+
    '<div class="perf-metrics">'+
      '<div><b>'+c.pipeClock+' ps</b><span>clock period (slowest stage + overhead)</span></div>'+
      '<div><b>'+c.pipeGIPS.toFixed(2)+' GIPS</b><span>ideal pipelined throughput</span></div>'+
    '</div></div>';

  const c5 = computeClock(stageDelays, regOverhead);
  const delayVals = ['F','D','E','M','W'].map(function(s){ return stageDelays[s]; });
  const maxDelay = Math.max.apply(null, delayVals.concat([1]));
  let slowest = 'F';
  ['F','D','E','M','W'].forEach(function(s){ if (stageDelays[s] > stageDelays[slowest]) slowest = s; });
  out += '<div class="perf-block"><h4>Apply it to the Y86 5-stage pipeline</h4>'+
    '<div class="stage-inputs">'+
      ['F','D','E','M','W'].map(function(s){ return '<label>'+s+' (ps)<input type="number" id="stage-'+s+'" value="'+stageDelays[s]+'" min="1"></label>'; }).join('')+
      '<label>reg. overhead (ps)<input type="number" id="stage-ov" value="'+regOverhead+'" min="0"></label>'+
    '</div>'+
    ['F','D','E','M','W'].map(function(s){ return barHtml(s, (stageDelays[s]/maxDelay)*100, stageDelays[s]+' ps', s===slowest?'pipe':'seq'); }).join('')+
    '<div class="perf-metrics" style="margin-top:8px;">'+
      '<div><b>'+c5.pipeClock+' ps</b><span>pipelined clock period</span></div>'+
      '<div><b>'+c5.seqClock+' ps</b><span>unpipelined (SEQ) clock period</span></div>'+
      '<div><b>'+c5.pipeGIPS.toFixed(2)+' GIPS</b><span>ideal pipelined throughput</span></div>'+
      '<div><b>'+c5.seqGIPS.toFixed(2)+' GIPS</b><span>SEQ throughput (1 instr/cycle, slow cycle)</span></div>'+
    '</div></div>';

  if (machine){
    const cycles = machine.cycle;
    const retired = machine.stats.instrRetired;
    const cpi = retired>0 ? (cycles/retired) : 0;
    const ipc = cycles>0 ? (retired/cycles) : 0;
    const seqCycles = retired;
    const pipeTimePs = cycles * c5.pipeClock;
    const seqTimePs = seqCycles * c5.seqClock;
    const speedup = pipeTimePs>0 ? (seqTimePs/pipeTimePs) : 0;
    const maxTime = Math.max(pipeTimePs, seqTimePs, 1);
    out += '<div class="perf-block"><h4>This program, measured</h4>'+
      '<div class="perf-metrics">'+
        '<div><b>'+cycles+'</b><span>PIPE cycles actually taken</span></div>'+
        '<div><b>'+seqCycles+'</b><span>SEQ-equivalent cycles (1 / instr)</span></div>'+
        '<div><b>'+cpi.toFixed(2)+'</b><span>CPI (cycles per instruction)</span></div>'+
        '<div><b>'+ipc.toFixed(2)+'</b><span>IPC (instructions per cycle)</span></div>'+
        '<div><b>'+machine.stats.bubblesInserted+'</b><span>bubble cycles inserted</span></div>'+
        '<div><b>'+speedup.toFixed(2)+'\u00d7</b><span>estimated PIPE speedup over SEQ (using the clock periods above)</span></div>'+
      '</div>'+
      barHtml('SEQ', (seqTimePs/maxTime)*100, Math.round(seqTimePs)+' ps total', 'seq')+
      barHtml('PIPE', (pipeTimePs/maxTime)*100, Math.round(pipeTimePs)+' ps total', 'pipe')+
      '<p style="color:var(--text-faint);font-size:11px;margin-bottom:0;">SEQ never stalls (everything is resolved by the time the next instruction starts) but pays a much longer clock period every single cycle. PIPE pays some cycles to stalls/bubbles but runs a far shorter clock. Which wins depends on both hazards AND the stage delays above - try making stages very unbalanced.</p>'+
      '</div>';
  } else {
    out += '<div class="perf-block"><h4>This program, measured</h4><div class="sig-empty">Assemble a program to see its measured CPI/IPC and a real SEQ-vs-PIPE time comparison.</div></div>';
  }

  panel.innerHTML = out;
  wirePerfInputs();
}

function wirePerfInputs(){
  const abcA = el('abc-a'), abcB = el('abc-b'), abcC = el('abc-c'), abcOv = el('abc-ov');
  if (abcA){
    [abcA,abcB,abcC,abcOv].forEach(function(inp){
      inp.addEventListener('change', function(){
        classicABC = { A:(+abcA.value||1), B:(+abcB.value||1), C:(+abcC.value||1), ov:(+abcOv.value||0) };
        renderPerf();
      });
    });
  }
  document.querySelectorAll('[data-preset]').forEach(function(btn){
    btn.addEventListener('click', function(){
      if (btn.getAttribute('data-preset')==='unbalanced') classicABC = {A:50,B:150,C:100,ov:20};
      else classicABC = {A:100,B:100,C:100,ov:20};
      renderPerf();
    });
  });
  ['F','D','E','M','W'].forEach(function(s){
    const inp = el('stage-'+s);
    if (inp) inp.addEventListener('change', function(){ stageDelays[s] = (+inp.value||1); renderPerf(); });
  });
  const ov = el('stage-ov');
  if (ov) ov.addEventListener('change', function(){ regOverhead = (+ov.value||0); renderPerf(); });
}

// ================= Scenario generator =================
function renderGenerator(){
  const body = el('generator-body');
  body.innerHTML =
    '<div class="gen-row"><select id="gen-type" style="width:100%;">'+
      '<option value="chain">Dependency chain (choose the gap)</option>'+
      '<option value="independent">Independent instructions (choose the count)</option>'+
      '<option value="branch">Conditional branch (choose the outcome)</option>'+
      '<option value="callret">Function call, N levels deep</option>'+
      '<option value="loaduse">Load-use, with an adjustable gap</option>'+
    '</select></div>'+
    '<div class="gen-row" id="gen-params"></div>'+
    '<button class="btn btn-primary" id="gen-run" style="width:100%;justify-content:center;">Generate &amp; load</button>'+
    '<div class="gen-note" id="gen-note"></div>';
  const paramsEl = el('gen-params');
  function renderParams(){
    const type = el('gen-type').value;
    if (type==='chain'){
      paramsEl.innerHTML = '<span class="field-label">NOPs between producer and consumer</span><input type="number" id="gen-gap" min="0" max="6" value="0" style="width:60px;">';
    } else if (type==='independent'){
      paramsEl.innerHTML = '<span class="field-label">Instruction count</span><input type="number" id="gen-count" min="2" max="8" value="4" style="width:60px;">';
    } else if (type==='branch'){
      paramsEl.innerHTML = '<span class="field-label">Outcome</span><select id="gen-taken" style="flex:1;"><option value="nottaken">Not taken (matches prediction)</option><option value="taken">Taken (mispredicts)</option></select>';
    } else if (type==='callret'){
      paramsEl.innerHTML = '<span class="field-label">Call depth</span><input type="number" id="gen-depth" min="1" max="4" value="2" style="width:60px;">';
    } else if (type==='loaduse'){
      paramsEl.innerHTML = '<span class="field-label">Instructions between load and use</span><input type="number" id="gen-lu-gap" min="0" max="4" value="0" style="width:60px;">';
    }
  }
  el('gen-type').addEventListener('change', renderParams);
  renderParams();

  el('gen-run').addEventListener('click', function(){
    const type = el('gen-type').value;
    let src, note;
    if (type==='chain'){
      const gap = Math.max(0, parseInt(el('gen-gap').value,10)||0);
      const nopLines = [];
      for (let i=0;i<gap;i++) nopLines.push('nop');
      const nops = nopLines.join('\n');
      src = '# generated: dependency chain with '+gap+' NOP'+(gap===1?'':'s')+' between producer and consumer\n'+
        'irmovl $10, %edx\n'+(nops?nops+'\n':'')+'addl %edx, %eax\nhalt';
      note = 'With forwarding ON, this is safe at any gap (including 0). Turn forwarding OFF above and increase the gap until it becomes correct again - that tells you exactly how many cycles forwarding was saving you.';
    } else if (type==='independent'){
      const n = Math.min(8, Math.max(2, parseInt(el('gen-count').value,10)||2));
      const regs = ['eax','ebx','ecx','edx','esi','edi','ebp','esp'];
      const lines = [];
      for (let i=0;i<n;i++) lines.push('irmovl $'+((i+1)*10)+', %'+regs[i%8]);
      src = '# generated: '+n+' fully independent instructions\n'+lines.join('\n')+'\nhalt';
      note = 'No instruction here touches another instruction\u2019s register, so the pipeline should never stall or bubble - check the Performance tab: bubbles should read 0.';
    } else if (type==='branch'){
      const taken = el('gen-taken').value==='taken';
      if (taken){
        src = '# generated: branch that IS taken (mispredicts against predict-not-taken)\n'+
          'irmovl $1, %eax\nirmovl $1, %ebx\nsubl %ebx, %eax\nje target\nirmovl $999, %ecx\ntarget:\nirmovl $7, %edx\nhalt';
        note = 'eax-ebx is 0, so je is taken. Watch the Mispredicts counter go to 1 and irmovl $999 get flushed before it ever retires.';
      } else {
        src = '# generated: branch that is NOT taken (matches the predict-not-taken guess)\n'+
          'irmovl $5, %eax\nirmovl $1, %ebx\nsubl %ebx, %eax\nje target\nirmovl $111, %ecx\ntarget:\nirmovl $7, %edx\nhalt';
        note = 'eax-ebx is 4, not 0, so je falls through. Mispredicts should stay at 0 and %ecx should end up as 111.';
      }
    } else if (type==='callret'){
      const depth = Math.min(4, Math.max(1, parseInt(el('gen-depth').value,10)||1));
      const lines = ['# generated: '+depth+'-level nested function call', 'irmovl $300, %esp', 'irmovl $300, %ebp', 'call f1', 'irmovl $999, %edx', 'halt'];
      for (let i=1;i<=depth;i++){
        lines.push('f'+i+':');
        if (i<depth){ lines.push('call f'+(i+1)); }
        lines.push('irmovl $'+(i*10)+', %eax');
        lines.push('ret');
      }
      src = lines.join('\n');
      note = 'Each call pushes a return address and jumps forward; each ret costs 3 bubble cycles because the target address only becomes known once it reaches Write-back. With '+depth+' nested calls, expect RET stalls to read '+(depth*3)+' in the status strip (3 cycles \u00d7 '+depth+' returns).';
    } else {
      const gap = Math.max(0, parseInt(el('gen-lu-gap').value,10)||0);
      const filler = [];
      for (let i=0;i<gap;i++) filler.push('irmovl $1, %edi');
      src = '# generated: load-use hazard with a '+gap+'-instruction gap\n'+
        'irmovl $9, %ebx\nrmmovl %ebx, 0(%ebx)\nmrmovl 0(%ebx), %ecx\n'+(filler.length?filler.join('\n')+'\n':'')+'addl %ecx, %ebx\nhalt';
      note = gap===0
        ? 'Zero gap: this is the hazard in its purest form - expect exactly 1 load-use stall.'
        : 'With a '+gap+'-instruction gap, the loaded value has more time to become available. See if the Performance tab still shows a load-use stall, or if the gap was already enough on its own.';
    }
    el('source').value = src;
    el('prog-name').textContent = '\u2014 generated';
    currentExampleKey = null;
    buildExampleList();
    doAssemble();
    el('gen-note').textContent = note;
  });
}

// ================= runtime capabilities (downloads) =================
let downloadsCap = null;

function updateExportButtons(){
  const has = !!downloadsCap;
  el('btn-export-program').disabled = !has;
  el('btn-export-trace').disabled = !has || !machine;
  el('btn-export-program').title = has ? 'Download the current program as a file' : 'File downloads are not available in this view';
  el('btn-export-trace').title = has ? 'Download the full cycle trace as JSON' : 'File downloads are not available in this view';
}
async function exportProgram(){
  if (!downloadsCap) return;
  try{ await downloadsCap.save({ filename:'y86-program.txt', data: el('source').value }); }
  catch(e){ /* viewer declined or it's unavailable - nothing more to do */ }
}
async function exportTrace(){
  if (!downloadsCap || !machine) return;
  const data = JSON.stringify({
    program: el('source').value,
    options: opts,
    stats: machine.stats,
    finishReason: machine.finishReason,
    history: machine.history,
  }, null, 2);
  try{ await downloadsCap.save({ filename:'y86-cycle-trace.json', data: data }); }
  catch(e){ /* viewer declined or it's unavailable */ }
}

// ================= wiring =================
function buildExampleList(){
  const list = el('example-list');
  list.innerHTML = EXAMPLES.map(function(ex){
    return '<div class="example-item'+(ex.key===currentExampleKey?' active':'')+'" data-key="'+ex.key+'">'+
      escapeHtml(ex.name)+
      '<div class="example-desc">'+escapeHtml(ex.desc)+'</div>'+
    '</div>';
  }).join('');
  list.querySelectorAll('.example-item').forEach(function(item){
    item.addEventListener('click', function(){
      const key = item.getAttribute('data-key');
      loadExample(key);
    });
  });
}
function loadExample(key){
  const ex = EXAMPLES.find(function(e){ return e.key===key; });
  if (!ex) return;
  currentExampleKey = key;
  el('source').value = ex.src;
  el('prog-name').textContent = '\u2014 '+ex.name;
  buildExampleList();
  doAssemble();
}

function wireControls(){
  el('btn-assemble').addEventListener('click', function(){ doAssemble(); });
  el('btn-step').addEventListener('click', function(){ pause(); stepOnce(); });
  el('btn-run').addEventListener('click', function(){ running ? pause() : run(); });
  el('btn-reset').addEventListener('click', function(){ resetMachine(); });
  el('speed').addEventListener('input', function(){ if (running){ run(); } });

  el('chk-fwd').addEventListener('change', function(e){ opts.forwarding = e.target.checked; el('tg-fwd').classList.toggle('active', opts.forwarding); resetMachine(); });
  el('chk-stall').addEventListener('change', function(e){ opts.stalls = e.target.checked; el('tg-stall').classList.toggle('active', opts.stalls); resetMachine(); });
  el('chk-pt').addEventListener('change', function(e){ opts.predictTaken = e.target.checked; el('tg-pt').classList.toggle('active', opts.predictTaken); resetMachine(); });

  el('btn-export-program').addEventListener('click', exportProgram);
  el('btn-export-trace').addEventListener('click', exportTrace);

  el('btn-cyc-prev').addEventListener('click', function(){ if (machine) goToCycle(machine.cycle-1); });
  el('btn-cyc-next').addEventListener('click', function(){ if (machine) goToCycle(machine.cycle+1); });
  el('btn-cyc-go').addEventListener('click', function(){ goToCycle(parseInt(el('cyc-jump').value,10)||0); });
  el('btn-cyc-live').addEventListener('click', function(){ goToCycle(maxCycleSeen); });
  el('cyc-jump').addEventListener('keydown', function(e){ if (e.key==='Enter') goToCycle(parseInt(el('cyc-jump').value,10)||0); });

  el('cmp-go').addEventListener('click', function(){
    compareCycles(parseInt(el('cmp-a').value,10)||1, parseInt(el('cmp-b').value,10)||1);
  });

  document.querySelectorAll('.tab').forEach(function(tab){
    tab.addEventListener('click', function(){
      document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
      tab.classList.add('active');
      el('panel-'+tab.getAttribute('data-tab')).classList.add('active');
    });
  });

  el('btn-theme').addEventListener('click', function(){
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme');
    root.setAttribute('data-theme', cur==='light' ? 'dark' : 'light');
  });
}

function init(){
  wireControls();
  buildExampleList();
  renderGenerator();
  renderGuideTab();
  loadExample(currentExampleKey);
  initCapabilities();
}

document.addEventListener('DOMContentLoaded', init);
})();
