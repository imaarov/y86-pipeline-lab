# Y86 Pipeline Lab
A Y86 pipeline visualizer based on CS:APP Chapter 4, built with AI to help me understand pipelining.
You can check out the Y86 simulator here: [Y86 Pipeline Lab](https://imaarov.github.io/y86-pipeline-lab/)

## What it simulate

- **Y86 assembler**  labels, `.pos`/`.long` directives, and the core instruction set (`halt`, `nop`, `irmovl`, `rrmovl`, `rmmovl`, `mrmovl`, `addl/subl/andl/xorl`, `jmp/jle/jl/je/jne/jge/jg`, `call`, `ret`, `pushl`, `popl`).
- **A 5-stage pipeline**,every value shown in the UI is read directly from live pipeline-register state.
- **Data hazard handling**: forwarding from Execute/Memory/Write-back, and a real load-use stall when forwarding can't help.
- **Control hazard handling**: predict-not-taken branching with a 2-cycle misprediction flush, and a correct `call`/`ret` implementation (including the 3-cycle stall while a return address is in flight).
- **Toggles** for forwarding, stalling, and branch prediction, so you can turn off the machinery and watch it break.
- A live **pipeline diagram**, a **cycle timeline** you can click into, a **signal inspector** per stage, **register/memory/condition-code** views (with a value-history table), a **cycle rewind/jump** control (deterministic replay, not snapshots), and a **compare-two-cycles** diff view.
- A **performance lab**: the classic non-uniform pipeline clock-period exercise, applied both generically and to Y86's actual 5 stages, plus real measured CPI/IPC and a SEQ-vs-PIPE time comparison for whatever program is loaded.
- A **Learn tab**: concept notes, common misconceptions (with counterexamples), and a short quiz that remembers what you've missed.
- A **scenario generator** for dependency chains, independent blocks, branches, nested calls, and load-use gaps, plus nine built-in worked scenarios.


## Known limitations

- SEQ (the unpipelined baseline) is modeled analytically for the performance comparison, not run as a second literal instruction-by-instruction engine.
- The instruction set is a meaningful Y86 subset, not the full ISA (no `cmovXX` variants beyond plain `rrmovl`, no floating point).
- The full 19-module curriculum, an adaptive-scheduling tutor, and a constraint-based scenario solver from the original design brief are not built, the Learn tab and generator cover the core ideas rather than the exhaustive version.

## Why this exists

Because I was reading the CS:APP book, specifically chapter 4, which talks about the Y86 and especially pipelining, I needed a visualization or some kind of tool that could simulate the pipeline to help me understand it better.
