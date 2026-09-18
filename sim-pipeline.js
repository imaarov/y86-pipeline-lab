// depends on sim-core.js definitions being loaded first (concatenated at test time)

class Machine {
  constructor(asm, opts){
    this.mem = asm.bytes.slice(); // working copy, code + data share this space
    this.instrAt = asm.instrAt;
    this.regs = new Int32Array(8);
    this.cc = { ZF:1, SF:0, OF:0 }; // Y86 starts with ZF=1 conventionally
    this.pc = 0;
    this.opts = Object.assign({ forwarding:true, stalls:true, predictTaken:false }, opts);

    const bubble = () => ({ bubble:true, stat:STAT.BUB, icode:ICODE.BUBBLE, ifun:0, rA:REG.NONE, rB:REG.NONE,
      valC:0, valP:0, valA:0, valB:0, valE:0, valM:0, dstE:REG.NONE, dstM:REG.NONE, srcA:REG.NONE, srcB:REG.NONE,
      Cnd:false, id:null, addr:null });
    this._bubbleMaker = bubble;
    this.D = bubble(); this.E = bubble(); this.M = bubble(); this.W = bubble();

    this.cycle = 0;
    this.running = false;
    this.finished = false;
    this.finishReason = null;
    this.instrCounter = 0; // for assigning I1, I2, ... labels in fetch order
    this.fetchHalted = false; // true once a HALT has been fetched; blocks further fetching while it drains
    this.retiredCount = 0;
    this.stats = { cycles:0, instrRetired:0, bubblesInserted:0, stallCycles:0, mispredicts:0, loadUseStalls:0, retStalls:0 };
    this.history = []; // per-cycle snapshot for the timeline / scrubber
    this.lastCycleLog = null; // human-readable explanation lines for the last cycle
  }

  fetchAt(addr){
    const meta = this.instrAt.get(addr);
    if (!meta){
      // could be a zero byte in memory -> decodes as HALT (icode 0, ifun 0), matches real Y86 semantics
      const byte = (addr>=0 && addr<this.mem.length) ? this.mem[addr] : null;
      if (byte===0){
        return { stat:STAT.AOK, icode:ICODE.HALT, ifun:0, rA:REG.NONE, rB:REG.NONE, valC:0, valP:addr+1, addr, len:1, text:'halt' };
      }
      return { stat:STAT.INS, icode:ICODE.INVALID, ifun:0, rA:REG.NONE, rB:REG.NONE, valC:0, valP:addr+1, addr, len:1, text:'<invalid>' };
    }
    return Object.assign({ stat: STAT.AOK }, meta);
  }

  // ---- one full clock cycle ----
  step(){
    if (this.finished) return false;
    const log = [];
    const opts = this.opts;

    // ===== combinational: EXECUTE (based on current E register) =====
    const ex = this.computeExecute(this.E);
    // ===== combinational: MEMORY (based on current M register) =====
    const mm = this.computeMemory(this.M);
    // ===== combinational: WRITEBACK (based on current W register) =====
    const wb = this.W; // fields already final (valE/valM/dstE/dstM) from when it was produced

    // ===== combinational: DECODE (based on current D register), using forwarding from ex/mm/W and regfile =====
    const dec = this.computeDecode(this.D, ex, mm);

    // ===== hazard detection =====
    const loadUseHazard = opts.stalls && (this.E.icode===ICODE.MRMOVL || this.E.icode===ICODE.POPL) &&
      this.E.dstM !== REG.NONE && (this.E.dstM===dec.srcA || this.E.dstM===dec.srcB);

    const retInFlight = (this.D.icode===ICODE.RET) || (this.E.icode===ICODE.RET) || (this.M.icode===ICODE.RET);

    // Unconditional jumps (ifun 0) are resolved at Fetch (the target is right there in the
    // instruction, no condition code to wait for) so they never "mispredict". Only conditional
    // branches gamble on predictTaken and can be corrected later in Execute.
    const mispredict = (this.E.icode===ICODE.JXX) && (this.E.ifun!==0) && (ex.Cnd !== opts.predictTaken);

    // ===== FETCH (combinational) - uses this.pc =====
    let fetchOut = null;
    let pcNext;
    let retReturning = (this.W.icode===ICODE.RET);

    if (retReturning){
      pcNext = wb.valM >>> 0;
      log.push(`RET completed write-back: PC now jumps to the return address 0x${(pcNext>>>0).toString(16)} pulled from the stack.`);
    } else if (mispredict){
      pcNext = ex.branchTarget >>> 0;
      log.push(`Branch in Execute resolved TAKEN, but we predicted NOT-TAKEN. Flushing the two wrong-path instructions and refetching at 0x${pcNext.toString(16)}.`);
      this.stats.mispredicts++;
    } else if (retInFlight){
      pcNext = this.pc; // hold; real return address not known until RET reaches write-back
    } else if (loadUseHazard){
      pcNext = this.pc; // hold; re-fetch same instruction next cycle
    } else if (this.fetchHalted){
      pcNext = this.pc; // a HALT has already been fetched; stop fetching further instructions
    } else {
      fetchOut = this.fetchAt(this.pc);
      if (fetchOut.icode===ICODE.HALT) this.fetchHalted = true;
      if (fetchOut.icode===ICODE.CALL || (fetchOut.icode===ICODE.JXX && fetchOut.ifun===0)){
        // call and unconditional jmp: the target is immediately known, so Fetch redirects
        // right away instead of guessing - there's nothing to predict.
        pcNext = fetchOut.valC;
      } else {
        pcNext = fetchOut.valP;
      }
    }

    // ===== decide next D / E / M / W =====
    let D_next, E_next;
    const mkId = (meta) => {
      this.instrCounter++;
      return this.instrCounter;
    };

    if (mispredict){
      E_next = this._bubbleMaker();
      D_next = this._bubbleMaker();
      log.push(`E (the branch instruction) moves on to Memory; a bubble is inserted where the wrongly-fetched instruction used to be.`);
    } else if (retInFlight){
      // RET itself (and anything already ahead of it in D) still advances normally through
      // the pipeline - what's suppressed is fetching NEW instructions, since the correct PC
      // isn't known until RET's return address reaches Write-back.
      E_next = this.D.bubble ? this._bubbleMaker() : this.buildEfromD(this.D, dec);
      D_next = this._bubbleMaker();
      this.stats.retStalls++;
    } else if (loadUseHazard){
      E_next = this._bubbleMaker();
      D_next = { ...this.D }; // hold D, it will be decoded again next cycle
      this.stats.loadUseStalls++;
      log.push(`Load-use hazard: the instruction in Decode needs a register that the load in Execute hasn't produced yet. Stalling Fetch/Decode and inserting a bubble into Execute.`);
    } else {
      D_next = fetchOut ? this.tagFetched(fetchOut, mkId) : this._bubbleMaker();
      E_next = this.D.bubble ? this._bubbleMaker() : this.buildEfromD(this.D, dec);
    }

    const M_next = this.E.bubble ? this._bubbleMaker() : this.buildMfromE(this.E, ex);
    const W_next = this.M.bubble ? this._bubbleMaker() : this.buildWfromM(this.M, mm);

    // ===== commit: register writes, cc update, retirement bookkeeping =====
    if (!this.W.bubble){
      if (this.W.dstE !== REG.NONE) this.regs[this.W.dstE] = this.W.valE|0;
      if (this.W.dstM !== REG.NONE) this.regs[this.W.dstM] = this.W.valM|0;
      this.retiredCount++;
      this.stats.instrRetired++;
      if (this.W.icode===ICODE.HALT){
        this.finishReason = 'halt';
      } else if (this.W.stat===STAT.INS){
        this.finishReason = 'invalid-instruction';
      } else if (this.W.stat===STAT.ADR){
        this.finishReason = 'address-error';
      }
    }
    if (this.E.icode===ICODE.OPL && !this.E.bubble){
      this.cc = ex.cc;
    }
    if (E_next && E_next.bubble) this.stats.bubblesInserted++;

    // snapshot BEFORE mutating pipeline registers, so UI can show "this cycle" clearly.
    // F here means "the instruction that got latched into D as a result of this cycle's
    // fetch" (i.e. D_next) - that's the conventional meaning of "F occupant during cycle N"
    // on a pipeline timing diagram, distinct from this.D/E/M/W which are the OLD (pre-cycle) contents.
    const snapshot = {
      cycle: this.cycle+1,
      pc: this.pc,
      F: (D_next && !D_next.bubble) ? { id: D_next.id, text: D_next.text, addr: D_next.addr } : null,
      D: this.D, E: this.E, M: this.M, W: this.W,
      decode: dec, execute: ex, memory: mm,
      loadUseHazard, retInFlight, mispredict,
      regsAfter: null, // filled below
      cc: this.cc,
      log,
    };

    // advance state
    this.D = D_next; this.E = E_next; this.M = M_next; this.W = W_next;
    this.pc = pcNext;
    this.cycle++;
    this.stats.cycles = this.cycle;

    snapshot.regsAfter = Array.from(this.regs);
    this.history.push(snapshot);
    this.lastCycleLog = log;

    // termination: once HALT has retired AND pipeline has drained (all bubbles / nothing left AOK)
    if (this.finishReason && this.D.bubble && this.E.bubble && this.M.bubble && this.W.bubble){
      this.finished = true;
      this.running = false;
    }
    // safety valve for runaway simulation (e.g. bad jump target loops forever)
    if (this.cycle > 20000){ this.finished = true; this.finishReason = 'cycle-limit'; }

    return true;
  }

  tagFetched(fetchOut, mkId){
    if (fetchOut.icode===ICODE.INVALID){
      return Object.assign({}, fetchOut, { bubble:false, id: mkId(), valP: fetchOut.valP, stat: STAT.INS });
    }
    return Object.assign({}, fetchOut, { bubble:false, id: mkId(), stat: STAT.AOK });
  }

  computeDecode(D, ex, mm){
    if (D.bubble) return { srcA:REG.NONE, srcB:REG.NONE, dstE:REG.NONE, dstM:REG.NONE, valA:0, valB:0, forwardedA:null, forwardedB:null };
    const f = decodeFields(D);
    const valA = this.readOperand(f.srcA, ex, mm, 'A');
    const valB = this.readOperand(f.srcB, ex, mm, 'B');
    return { srcA:f.srcA, srcB:f.srcB, dstE:f.dstE, dstM:f.dstM, valA: valA.value, valB: valB.value, forwardedA: valA.source, forwardedB: valB.source };
  }

  readOperand(reg, ex, mm, which){
    if (reg===REG.NONE) return { value:0, source:null };
    if (this.opts.forwarding){
      if (this.E.dstE===reg && !this.E.bubble) return { value: ex.valE, source:'Execute (ALU result)' };
      if (this.M.dstE===reg && !this.M.bubble) return { value: this.M.valE, source:'Memory (ALU result passthrough)' };
      if (this.M.dstM===reg && !this.M.bubble) return { value: mm.valM, source:'Memory (load result)' };
      if (this.W.dstE===reg && !this.W.bubble) return { value: this.W.valE, source:'Write-back (ALU result)' };
      if (this.W.dstM===reg && !this.W.bubble) return { value: this.W.valM, source:'Write-back (load result)' };
    }
    return { value: this.regs[reg], source:null };
  }

  computeExecute(E){
    if (E.bubble) return { valE:0, Cnd:false, cc:this.cc, branchTarget:0 };
    let valE = 0;
    switch(E.icode){
      case ICODE.RRMOVL: valE = E.valA; break;
      case ICODE.IRMOVL: valE = E.valC; break;
      case ICODE.RMMOVL:
      case ICODE.MRMOVL: valE = (E.valB + E.valC)|0; break;
      case ICODE.OPL: valE = alu(E.ifun, E.valB, E.valA); break;
      case ICODE.CALL:
      case ICODE.PUSHL: valE = (E.valB - 4)|0; break;
      case ICODE.RET:
      case ICODE.POPL: valE = (E.valB + 4)|0; break;
      default: valE = 0;
    }
    let cc = this.cc;
    if (E.icode===ICODE.OPL){
      cc = computeCC(E.ifun, E.valB, E.valA, valE);
    }
    let Cnd = false;
    if (E.icode===ICODE.JXX) Cnd = evalCondition(E.ifun, this.cc);
    return { valE, Cnd, cc, branchTarget: E.valC };
  }

  computeMemory(M){
    if (M.bubble) return { valM:0, memError:false };
    let valM = 0;
    switch(M.icode){
      case ICODE.MRMOVL: { const r = readWord(this.mem, M.valE); valM = r.value; break; }
      case ICODE.POPL: { const r = readWord(this.mem, M.valA); valM = r.value; break; }
      case ICODE.RET: { const r = readWord(this.mem, M.valA); valM = r.value; break; }
      case ICODE.RMMOVL: writeWord(this.mem, M.valE, M.valA); break;
      case ICODE.PUSHL: writeWord(this.mem, M.valE, M.valA); break;
      case ICODE.CALL: writeWord(this.mem, M.valE, M.valA); break;
    }
    return { valM };
  }

  buildEfromD(D, dec){
    // Select-A: CALL and JXX route valP through the valA channel instead of a register value,
    // since neither instruction needs a register-A read at the same time.
    const valA = (D.icode===ICODE.CALL || D.icode===ICODE.JXX) ? D.valP : dec.valA;
    return {
      bubble:false, id: D.id, addr: D.addr, text: D.text, stat: D.stat,
      icode: D.icode, ifun: D.ifun, valC: D.valC, valP: D.valP,
      valA, valB: dec.valB, dstE: dec.dstE, dstM: dec.dstM, srcA: dec.srcA, srcB: dec.srcB,
    };
  }

  buildMfromE(E, ex){
    return {
      bubble:false, id: E.id, addr: E.addr, text: E.text, stat: E.stat,
      icode: E.icode, ifun: E.ifun, Cnd: ex.Cnd, valE: ex.valE, valA: E.valA,
      dstE: E.dstE, dstM: E.dstM,
    };
  }

  buildWfromM(M, mm){
    return {
      bubble:false, id: M.id, addr: M.addr, text: M.text, stat: M.stat,
      icode: M.icode, valE: M.valE, valM: mm.valM, dstE: M.dstE, dstM: M.dstM,
    };
  }
}

function alu(ifun, b, a){
  switch(ifun){
    case 0: return (b + a)|0;
    case 1: return (b - a)|0;
    case 2: return (b & a)|0;
    case 3: return (b ^ a)|0;
  }
  return 0;
}
function computeCC(ifun, b, a, result){
  const ZF = (result===0) ? 1 : 0;
  const SF = (result<0) ? 1 : 0;
  let OF = 0;
  const signA = (a>>>31)&1, signB=(b>>>31)&1, signR=(result>>>31)&1;
  if (ifun===0) OF = (signA===signB && signR!==signA) ? 1 : 0; // add
  else if (ifun===1) OF = (signA!==signB && signR!==signB) ? 1 : 0; // sub: b - a
  return { ZF, SF, OF };
}
function evalCondition(ifun, cc){
  const {ZF,SF,OF} = cc;
  switch(ifun){
    case 0: return true; // jmp
    case 1: return (SF^OF)===1 || ZF===1; // jle
    case 2: return (SF^OF)===1; // jl
    case 3: return ZF===1; // je
    case 4: return ZF===0; // jne
    case 5: return (SF^OF)===0; // jge
    case 6: return (SF^OF)===0 && ZF===0; // jg
  }
  return false;
}
