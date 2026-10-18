# Open-source decompilers and analyzers

There is no single decompiler that fits every file format or recovers original
source exactly. Choose a tool for the artifact you have, then treat generated
source and pseudocode as analysis aids: compilers discard information, and
decompilers can produce incomplete or misleading output. Check the upstream
project's supported formats, architecture coverage, release state, and license
before relying on a result or adding a tool to a workflow.

## Choose by artifact

| Artifact | Tools to consider | What they are useful for | Scope and caveats |
| --- | --- | --- | --- |
| Native executables and firmware | [Ghidra](https://github.com/NationalSecurityAgency/ghidra) | Multi-platform software reverse engineering, disassembly, decompilation, and scripting across many processor and executable formats. | Broad coverage does not guarantee complete function recovery. REA supports an existing Ghidra installation; see the [Ghidra provider guide](ghidra-provider.md). |
| Native executables | [Rizin](https://github.com/rizinorg/rizin), [Cutter](https://github.com/rizinorg/cutter), and [rz-ghidra](https://github.com/rizinorg/rz-ghidra) | Rizin provides a command-line reverse-engineering framework; Cutter is its GUI; rz-ghidra adds Ghidra's decompiler to Rizin. | Rizin and Cutter are two interfaces in the same ecosystem. rz-ghidra reuses Ghidra's decompiler, so it is not an independent decompilation engine. REA can use caller-installed Rizin and Cutter; plugin availability depends on that installation. See [REA's integrations](reverse-engineering-tools.md#rizin). |
| Native executables | [Reko](https://github.com/uxmal/reko) | A separate machine-code decompiler with command-line and GUI frontends and a range of processor and executable-format backends. | Check its [supported-binaries list](https://github.com/uxmal/reko/wiki/Supported-binaries) for the exact target; architecture and loader coverage vary. |
| Native executables | [RetDec](https://github.com/avast/retdec) | An LLVM-based, retargetable machine-code decompiler. | The upstream project describes itself as being in limited maintenance mode. Consider this when choosing a tool for an ongoing workflow. |
| Android APK and DEX | [JADX](https://github.com/skylot/jadx) | Converts Dalvik bytecode to Java-like source and can decode Android resources. | Its maintainers warn that some code will not decompile completely. Keep DEX/smali and resource views available when source output is incomplete. |
| Java and JVM bytecode | [Vineflower](https://github.com/Vineflower/vineflower) | A general-purpose Java/JVM decompiler with command-line and library use. | Output is reconstructed source, not the original source; validate important control flow and types against bytecode. |
| .NET assemblies | [ILSpy](https://github.com/icsharpcode/ILSpy) | Browsing assemblies and decompiling .NET code to C#, with desktop, command-line, and IDE frontends. | Results depend on available metadata and referenced assemblies; missing references can limit reconstruction. |
| CPython `.pyc` files | [PyLingual](https://github.com/syssec-utd/pylingual) | Decompiling CPython bytecode across released Python versions from 3.6 onward. | Identify the bytecode version first. The project notes that its local open-source code may have lower control-flow accuracy than its hosted service. |
| JavaScript bundles | [Webcrack](https://github.com/j4k0xb/webcrack) | Unminifying, deobfuscating supported patterns, and unpacking Webpack or Browserify bundles. | This is bundle recovery and deobfuscation, not a general-purpose machine-code decompiler. |

For stripped Go executables, [GoReSym](https://github.com/mandiant/GoReSym) and
[Redress](https://github.com/goretk/redress) can recover Go runtime, symbol, and
type metadata. They complement a disassembler or decompiler; they do not replace
one.

## A practical selection workflow

1. Identify the file format, instruction set or bytecode version before
   installing an engine. For Go, Python, Android, and managed binaries, first
   check whether format-specific metadata or resources can answer the question
   without full decompilation.
2. Start with one tool whose documented input matches the artifact. Record the
   tool and version alongside the output so another analyst can reproduce it.
3. Compare a second implementation only when it provides independent evidence.
   For example, Rizin with `rz-ghidra` and standalone Ghidra share the Ghidra
   decompiler, so agreement between them is not an independent engine check.
4. Verify conclusions against raw bytes, disassembly, metadata, and other
   observations. Decompiled names and source-like syntax are derived output,
   not proof of original source or runtime behavior.
5. Check each project's license and the rights applicable to the target before
   use. Open-source availability does not grant rights to inspect or redistribute
   arbitrary software.

REA's provider support and caller-supplied tool integrations are documented in
[installation and setup](installation.md), the [provider guides](index.md), and
[reverse-engineering tool integrations](reverse-engineering-tools.md).
