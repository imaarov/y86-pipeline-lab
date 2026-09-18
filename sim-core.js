// ===== Y86 constants =====
const REG = { EAX:0, ECX:1, EDX:2, EBX:3, ESP:4, EBP:5, ESI:6, EDI:7, NONE:8 };
const REG_NAMES = ['%eax','%ecx','%edx','%ebx','%esp','%ebp','%esi','%edi'];
const REG_SHORT = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];

const ICODE = { HALT:0, NOP:1, RRMOVL:2, IRMOVL:3, RMMOVL:4, MRMOVL:5, OPL:6, JXX:7, CALL:8, RET:9, PUSHL:10, POPL:11, BUBBLE:-1, INVALID:-2 };
const ICODE_NAMES = { 0:'halt',1:'nop',2:'rrmovl',3:'irmovl',4:'rmmovl',5:'mrmovl',6:'OPl',7:'jXX',8:'call',9:'ret',10:'pushl',11:'popl',[-1]:'bubble',[-2]:'???' };
const OP_NAMES = { 0:'addl', 1:'subl', 2:'andl', 3:'xorl' };
const JUMP_NAMES = { 0:'jmp', 1:'jle', 2:'jl', 3:'je', 4:'jne', 5:'jge', 6:'jg' };

const STAT = { AOK:0, HLT:1, ADR:2, INS:3, BUB:4 };
const STAT_NAMES = { 0:'AOK', 1:'HLT', 2:'ADR', 3:'INS', 4:'BUB' };

const MEM_SIZE = 4096;

function toS32(x){ return x|0; }

// ---- decode field logic: srcA, srcB, dstE, dstM for a given instruction ----
function decodeFields(instr){
  const {icode, rA, rB} = instr;
  const N = REG.NONE;
  switch(icode){
    case ICODE.RRMOVL: return {srcA:rA, srcB:N, dstE:rB, dstM:N};
    case ICODE.IRMOVL: return {srcA:N, srcB:N, dstE:rB, dstM:N};
    case ICODE.RMMOVL: return {srcA:rA, srcB:rB, dstE:N, dstM:N};
    case ICODE.MRMOVL: return {srcA:N, srcB:rB, dstE:N, dstM:rA};
    case ICODE.OPL:    return {srcA:rA, srcB:rB, dstE:rB, dstM:N};
    case ICODE.JXX:    return {srcA:N, srcB:N, dstE:N, dstM:N};
    case ICODE.CALL:   return {srcA:N, srcB:REG.ESP, dstE:REG.ESP, dstM:N};
    case ICODE.RET:    return {srcA:REG.ESP, srcB:REG.ESP, dstE:REG.ESP, dstM:N};
    case ICODE.PUSHL:  return {srcA:rA, srcB:REG.ESP, dstE:REG.ESP, dstM:N};
    case ICODE.POPL:   return {srcA:REG.ESP, srcB:REG.ESP, dstE:REG.ESP, dstM:rA};
    default:           return {srcA:N, srcB:N, dstE:N, dstM:N};
  }
}

function needsValC(icode){
  return icode===ICODE.IRMOVL || icode===ICODE.RMMOVL || icode===ICODE.MRMOVL || icode===ICODE.JXX || icode===ICODE.CALL;
}
function needsRegByte(icode){
  return icode===ICODE.RRMOVL || icode===ICODE.IRMOVL || icode===ICODE.RMMOVL || icode===ICODE.MRMOVL ||
         icode===ICODE.OPL || icode===ICODE.PUSHL || icode===ICODE.POPL;
}
function instrLength(icode){
  let len = 1;
  if (needsRegByte(icode)) len += 1;
  if (needsValC(icode)) len += 4;
  return len;
}

// ===== Assembler =====
// Produces: { bytes: Uint8Array, instrAt: Map(addr->instrMeta), errors: [], order: [addr...], labels }
function assemble(source){
  const lines = source.split('\n');
  const errors = [];
  const labelDefs = {};
  const rawLines = []; // {addr, mnemonic, args, lineNo, label}
  let addr = 0;

  // Pass 1: strip comments, find labels & directives, compute addresses
  for (let i=0;i<lines.length;i++){
    let line = lines[i];
    const lineNo = i+1;
    let code = line.split('#')[0];
    code = code.trim();
    if (code.length===0) continue;

    let label = null;
    const labelMatch = code.match(/^([A-Za-z_.][A-Za-z0-9_]*):\s*(.*)$/);
    if (labelMatch){
      label = labelMatch[1];
      code = labelMatch[2].trim();
    }
    if (label){
      if (labelDefs.hasOwnProperty(label)) errors.push(`Line ${lineNo}: duplicate label "${label}"`);
      labelDefs[label] = addr;
    }
    if (code.length===0) continue;

    if (code.startsWith('.pos')){
      const m = code.match(/\.pos\s+(0x[0-9a-fA-F]+|\d+)/);
      if (m) addr = parseInt(m[1]);
      else errors.push(`Line ${lineNo}: bad .pos directive`);
      continue;
    }
    if (code.startsWith('.align')){
      const m = code.match(/\.align\s+(\d+)/);
      if (m){ const a = parseInt(m[1]); addr = Math.ceil(addr/a)*a; }
      continue;
    }
    if (code.startsWith('.long')){
      rawLines.push({addr, mnemonic:'.long', args: code.slice(5).trim(), lineNo});
      addr += 4;
      continue;
    }

    const parts = code.match(/^(\S+)\s*(.*)$/);
    if (!parts){ errors.push(`Line ${lineNo}: cannot parse "${code}"`); continue; }
    const mnemonic = parts[1].toLowerCase();
    const args = parts[2].trim();
    const icode = mnemonicToIcode(mnemonic);
    if (icode===null){ errors.push(`Line ${lineNo}: unknown instruction "${mnemonic}"`); continue; }
    rawLines.push({addr, mnemonic, args, lineNo});
    addr += instrLength(icode);
  }

  const bytes = new Uint8Array(MEM_SIZE);
  const instrAt = new Map();
  const order = [];

  function resolveImm(tok, lineNo){
    tok = tok.trim();
    if (tok.startsWith('$')) tok = tok.slice(1);
    if (labelDefs.hasOwnProperty(tok)) return labelDefs[tok];
    if (/^0x[0-9a-fA-F]+$/.test(tok)) return parseInt(tok,16);
    if (/^-?\d+$/.test(tok)) return parseInt(tok,10);
    errors.push(`Line ${lineNo}: cannot resolve "${tok}"`);
    return 0;
  }
  function regNum(tok, lineNo){
    tok = tok.trim().toLowerCase();
    const idx = REG_NAMES.indexOf(tok);
    if (idx===-1){ errors.push(`Line ${lineNo}: bad register "${tok}"`); return REG.NONE; }
    return idx;
  }

  for (const rl of rawLines){
    if (rl.mnemonic === '.long'){
      const v = resolveImm(rl.args, rl.lineNo);
      writeWord(bytes, rl.addr, v);
      continue;
    }
    const icode = mnemonicToIcode(rl.mnemonic);
    let ifun = 0, rA = REG.NONE, rB = REG.NONE, valC = 0;
    const a = rl.args;
    try {
      switch(icode){
        case ICODE.HALT: case ICODE.NOP: case ICODE.RET: break;
        case ICODE.RRMOVL: {
          const [s,d] = splitArgs(a); rA = regNum(s, rl.lineNo); rB = regNum(d, rl.lineNo); break;
        }
        case ICODE.IRMOVL: {
          const [s,d] = splitArgs(a); valC = resolveImm(s, rl.lineNo); rB = regNum(d, rl.lineNo); rA = REG.NONE; break;
        }
        case ICODE.RMMOVL: {
          const [s,d] = splitArgs(a); rA = regNum(s, rl.lineNo);
          const mm = d.match(/^(-?\w*)\((%\w+)\)$/);
          if (!mm){ errors.push(`Line ${rl.lineNo}: bad memory operand "${d}"`); break; }
          valC = mm[1]==='' ? 0 : resolveImm(mm[1], rl.lineNo); rB = regNum(mm[2], rl.lineNo); break;
        }
        case ICODE.MRMOVL: {
          const [s,d] = splitArgs(a);
          const mm = s.match(/^(-?\w*)\((%\w+)\)$/);
          if (!mm){ errors.push(`Line ${rl.lineNo}: bad memory operand "${s}"`); break; }
          valC = mm[1]==='' ? 0 : resolveImm(mm[1], rl.lineNo); rB = regNum(mm[2], rl.lineNo);
          rA = regNum(d, rl.lineNo); break;
        }
        case ICODE.OPL: {
          ifun = opMnemonicToIfun(rl.mnemonic);
          const [s,d] = splitArgs(a); rA = regNum(s, rl.lineNo); rB = regNum(d, rl.lineNo); break;
        }
        case ICODE.JXX: {
          ifun = jumpMnemonicToIfun(rl.mnemonic);
          valC = resolveImm(a, rl.lineNo); break;
        }
        case ICODE.CALL: {
          valC = resolveImm(a, rl.lineNo); break;
        }
        case ICODE.PUSHL: case ICODE.POPL: {
          rA = regNum(a, rl.lineNo); rB = REG.NONE; break;
        }
      }
    } catch(e){ errors.push(`Line ${rl.lineNo}: ${e.message}`); }

    const len = instrLength(icode);
    let p = rl.addr;
    bytes[p] = ((icode & 0xF) << 4) | (ifun & 0xF); p++;
    if (needsRegByte(icode)){ bytes[p] = ((rA & 0xF) << 4) | (rB & 0xF); p++; }
    if (needsValC(icode)){ writeWord(bytes, p, valC); p += 4; }

    const meta = { addr: rl.addr, icode, ifun, rA, rB, valC, valP: rl.addr+len, len, mnemonic: rl.mnemonic, args: rl.args, lineNo: rl.lineNo, text: formatInstr(icode, ifun, rA, rB, valC, labelDefs) };
    instrAt.set(rl.addr, meta);
    order.push(rl.addr);
  }

  return { bytes, instrAt, errors, order, labels: labelDefs };
}

function splitArgs(a){
  const idx = a.indexOf(',');
  if (idx===-1) return [a.trim(), ''];
  return [a.slice(0,idx).trim(), a.slice(idx+1).trim()];
}
function writeWord(bytes, addr, val){
  val = val|0;
  for (let i=0;i<4;i++) bytes[addr+i] = (val >>> (8*i)) & 0xFF;
}
function readWord(bytes, addr){
  if (addr<0 || addr+4>bytes.length) return {value:0, fault:true};
  let v = 0;
  for (let i=0;i<4;i++) v |= (bytes[addr+i] << (8*i));
  return {value: v|0, fault:false};
}

function mnemonicToIcode(m){
  m = m.toLowerCase();
  if (m==='halt') return ICODE.HALT;
  if (m==='nop') return ICODE.NOP;
  if (m==='rrmovl') return ICODE.RRMOVL;
  if (m==='irmovl') return ICODE.IRMOVL;
  if (m==='rmmovl') return ICODE.RMMOVL;
  if (m==='mrmovl') return ICODE.MRMOVL;
  if (['addl','subl','andl','xorl'].includes(m)) return ICODE.OPL;
  if (['jmp','jle','jl','je','jne','jge','jg'].includes(m)) return ICODE.JXX;
  if (m==='call') return ICODE.CALL;
  if (m==='ret') return ICODE.RET;
  if (m==='pushl') return ICODE.PUSHL;
  if (m==='popl') return ICODE.POPL;
  return null;
}
function opMnemonicToIfun(m){ return {addl:0,subl:1,andl:2,xorl:3}[m.toLowerCase()]; }
function jumpMnemonicToIfun(m){ return {jmp:0,jle:1,jl:2,je:3,jne:4,jge:5,jg:6}[m.toLowerCase()]; }

function formatInstr(icode, ifun, rA, rB, valC, labels){
  const rn = i => REG_NAMES[i] || '?';
  switch(icode){
    case ICODE.HALT: return 'halt';
    case ICODE.NOP: return 'nop';
    case ICODE.RRMOVL: return `rrmovl ${rn(rA)}, ${rn(rB)}`;
    case ICODE.IRMOVL: return `irmovl $${valC}, ${rn(rB)}`;
    case ICODE.RMMOVL: return `rmmovl ${rn(rA)}, ${valC}(${rn(rB)})`;
    case ICODE.MRMOVL: return `mrmovl ${valC}(${rn(rB)}), ${rn(rA)}`;
    case ICODE.OPL: return `${OP_NAMES[ifun]} ${rn(rA)}, ${rn(rB)}`;
    case ICODE.JXX: return `${JUMP_NAMES[ifun]} 0x${valC.toString(16)}`;
    case ICODE.CALL: return `call 0x${valC.toString(16)}`;
    case ICODE.RET: return 'ret';
    case ICODE.PUSHL: return `pushl ${rn(rA)}`;
    case ICODE.POPL: return `popl ${rn(rA)}`;
    default: return '???';
  }
}

// quick self test
