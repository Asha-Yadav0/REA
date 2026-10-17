"""Run explicit local MCP and Codex comparisons; retain raw data outside the checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import time

import psutil


class CleanupIncomplete(RuntimeError):
    """The retained process owner must be settled before another trial."""

    def __init__(self, message, child, ownership):
        super().__init__(message)
        self.child = child  # Retain the direct-child handle for reaping after retry.
        self.ownership = ownership  # Persistence failure cannot release ownership.


def ownership_command(node, operation, ownership=None):
    command = [node, str(Path(__file__).with_name("benchmark-ownership.mjs")), operation]
    result = subprocess.run(command, input=json.dumps(ownership) if ownership is not None else None,
                            capture_output=True, text=True, timeout=60, check=True)
    return json.loads(result.stdout)


def measure(command, directory, prompt=None, timeout=600, *, node="node", memory_limit=6 * 1024**3):
    directory.mkdir(parents=True, exist_ok=False)
    # Prepare inspection and capture the identity baseline before measuring the task.
    ownership = ownership_command(node, "prepare")
    manifest = directory / "ownership.json"
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    began = time.monotonic()
    seen = {}
    peak = 0
    sample_count = 0
    denied_observations = 0
    timed_out = False
    cleanup = {"cleaned": False, "reason": "Cleanup has not run"}
    failure = None
    with (directory / "stdin.txt").open("w+") as input_stream, (directory / "stdout.log").open("w") as output, (directory / "process.stderr.log").open("w") as errors:
        if prompt:
            input_stream.write(prompt)
            input_stream.seek(0)
        child = subprocess.Popen(command, stdin=input_stream,
                                 stdout=output, stderr=errors, text=True, start_new_session=True,
                                 env={**os.environ, "R2_COLOR": "0", "R2_UTF8": "0",
                                      "REA_PROCESS_RUN_ID": ownership["runId"]})
        ownership.update(leaderPid=child.pid, processGroupId=child.pid)
        try:
            manifest.write_text(json.dumps(ownership, indent=2) + "\n")
            while child.poll() is None:
                try:
                    parent = psutil.Process(child.pid)
                    family = [parent, *parent.children(recursive=True)]
                except psutil.NoSuchProcess:
                    family = []
                rss = 0
                for process in family:
                    try:
                        with process.oneshot():
                            identity = (process.pid, process.create_time())
                            cpu = process.cpu_times()
                            rss += process.memory_info().rss
                            seen[identity] = max(seen.get(identity, 0), cpu.user + cpu.system)
                    except psutil.NoSuchProcess:
                        pass
                    except psutil.AccessDenied:
                        denied_observations += 1
                peak = max(peak, rss)
                sample_count += 1
                if time.monotonic() - began > timeout or rss > memory_limit:
                    timed_out = True
                    break
                time.sleep(0.05)
        except BaseException as cause:
            failure = cause
        finally:
            cleanup_began = time.monotonic()
            try:
                cleanup = ownership_command(node, "cleanup", ownership)
                if cleanup["cleaned"]:
                    child.wait(timeout=5)
            except Exception as cause:
                cleanup = {"cleaned": False, "reason": str(cause)}
            cleanup_seconds = time.monotonic() - cleanup_began
        code = child.poll()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    remaining = []
    for pid, created in seen:
        if pid == child.pid:
            continue
        try:
            process = psutil.Process(pid)
            if process.create_time() == created and process.status() != psutil.STATUS_ZOMBIE:
                remaining.append(pid)
        except psutil.NoSuchProcess:
            pass
        except psutil.AccessDenied:
            cleanup = {"cleaned": False, "reason": f"Cannot inspect observed PID {pid}"}
    if remaining:
        cleanup = {"cleaned": False, "reason": "Observed descendants remain alive"}
    result = {
        "elapsed_seconds": time.monotonic() - began,
        "cpu_user_seconds": after.ru_utime - before.ru_utime,
        "cpu_system_seconds": after.ru_stime - before.ru_stime,
        "sampled_family_cpu_seconds": sum(seen.values()),
        "sampled_peak_family_rss_bytes": peak,
        "sample_interval_seconds": 0.05, "samples": sample_count,
        "observed_processes": len(seen), "remaining_observed_pids": remaining,
        "denied_observations": denied_observations,
        "exit_code": code, "interrupted_by_limit": timed_out,
        "cleanup": cleanup, "cleanup_seconds": cleanup_seconds,
        "ownership_manifest": str(manifest),
    }
    try:
        (directory / "resources.json").write_text(json.dumps(result, indent=2) + "\n")
    except OSError as cause:
        if failure is None:
            failure = cause
    if not cleanup["cleaned"]:
        raise CleanupIncomplete(
            f"Owned cleanup is unverified; stopping trials. Retry with the retained ownership record "
            f"(manifest may be unavailable at {manifest}): {cleanup}", child, ownership) from failure
    if failure is not None:
        raise failure
    return result


def agent_command(config, lane, directory):
    native = lane.startswith("r2mcp")
    custom = config.get("servers", {}).get(lane)
    tools = custom["tools"] if custom else {
        "ghidra": ["open_binary", "procedure_pseudo_code", "procedure_assembly", "close_binary",
                   "search_strings", "xrefs", "resolve_containing_procedure", "procedure_callees", "analyze_function"],
        "r2-exec": ["execute_radare2_command"],
        "r2pipe2": ["start_radare2_session", "radare2_command", "close_radare2_session"],
        "r2mcp-raw": ["open_file", "run_command", "close_file"],
        "r2mcp-typed": ["open_file", "analyze", "decompile_function", "disassemble_function", "close_file",
                       "list_strings", "list_functions", "xrefs_to", "calculate"],
    }[lane]
    instruction = (
        "Use only the registered engine MCP tools for this static investigation. "
        "Do not run target code, write target bytes, fetch URLs, launch a GUI, or use other agents. "
        "Do not read source files or inspect other targets. Cite actual tool observations and addresses; "
        "use real REA Evidence IDs where provided, never invent them. "
        "Choose the analysis needed for the task; aa / analyze level 0 is basic analysis, "
        "and one-shot command processes do not retain analysis between calls. "
        "pdg is the available r2ghidra decompiler. "
        "Display policy is preconfigured: R2_COLOR=0, R2_UTF8=0, and embedded r2mcp startup sets "
        "scr.utf8=0 and asm.dwarf=false. Do not spend investigation calls checking display settings. "
        "Related read commands may be batched. Preserve unknowns and report tool failures. "
        "Close any opened analysis session before returning your answer."
    )
    if lane == "r2mcp-raw":
        instruction += (
            ' For run_command, encode an r2pipe2 request in the command string, '
            'for example {"cmd":"COMMAND","json":false,"trim":false}; '
            "retain the returned status and logs."
        )
    instruction += " " + config.get("instructions", "")
    workspace = directory / "workspace"
    workspace.mkdir(parents=True)
    settings = {
        "approval_policy": "never", "sandbox_mode": "read-only", "web_search": "disabled",
        "model_reasoning_effort": config["reasoning"], "developer_instructions": instruction,
        "features.multi_agent": False, "features.shell_tool": False,
        "features.unified_exec": False, "features.shell_snapshot": False,
        "mcp_servers.engine.command": custom["command"] if custom else config["r2mcp"] if native else config["node"],
        "mcp_servers.engine.args": custom["args"] if custom else (["-N", "-d", "pdg", "-c", "e asm.dwarf=false;e scr.utf8=0", *(["-r"] if lane == "r2mcp-raw" else [])]
                                    if native else [str(Path(config["rea3521"]) / "scripts/rea.mjs"), "mcp"]),
        "mcp_servers.engine.enabled_tools": tools,
        "mcp_servers.engine.required": True,
        "mcp_servers.engine.startup_timeout_sec": 60,
        "mcp_servers.engine.tool_timeout_sec": 600,
        "mcp_servers.engine.default_tools_approval_mode": "approve",
        "mcp_servers.engine.env.REA_LOG_LEVEL": "silent",
        "mcp_servers.engine.env.R2_COLOR": "0",
        "mcp_servers.engine.env.R2_UTF8": "0",
        "mcp_servers.engine.env.REA_R2_COMMAND": config["r2"],
        "mcp_servers.engine.env.GHIDRA_INSTALL_DIR": config["ghidra"],
        "mcp_servers.engine.env.JAVA_HOME": config["java"],
        "mcp_servers.engine.env.REA_ANALYSIS_PROVIDER": "ghidra",
    }
    for key, value in (custom or {}).get("env", {}).items():
        settings["mcp_servers.engine.env." + key] = value
    command = [config["codex"], "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
               "--strict-config", "--skip-git-repo-check", "--json", "--color", "never",
               "-m", config["model"], "-C", str(workspace),
               "--output-last-message", str(directory / "answer.txt")]
    for key, value in settings.items():
        command.extend(["-c", key + "=" + json.dumps(value)])
    command.append("-")
    (directory / "selected-settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    return command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("configuration", type=Path)
    parser.add_argument("mode", choices=["sdk", "agent"])
    parser.add_argument("--lanes", nargs="+")
    parser.add_argument("--targets", nargs="+")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--label", default="run")
    args = parser.parse_args()
    config = json.loads(args.configuration.read_text())
    if args.trials < 1:
        parser.error("--trials must be positive")
    unknown_lanes = set(args.lanes or ()) - set(config["lanes"])
    unknown_targets = set(args.targets or ()) - {target["id"] for target in config["targets"]}
    if unknown_lanes or unknown_targets:
        parser.error(f"Unknown selections: lanes={sorted(unknown_lanes)}, targets={sorted(unknown_targets)}")
    root = Path(config["output"]) / args.label
    root.mkdir(parents=True, exist_ok=True)
    lanes = args.lanes or config["lanes"]
    targets = [target for target in config["targets"] if not args.targets or target["id"] in args.targets]
    for trial in range(args.trials):
        # Alternate order to expose systematic first-run/cache effects.
        order = lanes if trial % 2 == 0 else list(reversed(lanes))
        for target in targets:
            for lane in order:
                directory = root / f"{args.mode}-{target['id']}-{lane}-{trial + 1}"
                if args.mode == "sdk":
                    command = [config["node"], config["sdk_driver"], str(args.configuration),
                               lane, target["id"], str(directory / "payload")]
                    result = measure(command, directory, node=config["node"])
                else:
                    setup = root / f"setup-{target['id']}-{lane}-{trial + 1}"
                    command = agent_command(config, lane, setup)
                    prompt = target["prompt"]
                    (setup / "prompt.txt").write_text(prompt)
                    before_digest = hashlib.sha256(Path(target["path"]).read_bytes()).hexdigest()
                    result = measure(command, directory, prompt=prompt, timeout=600, node=config["node"])
                    usage = []
                    calls = []
                    events = directory / "stdout.log"
                    for line in events.read_text().splitlines():
                        event = json.loads(line)
                        if "usage" in event:
                            usage.append(event["usage"])
                        item = event.get("item", {})
                        if event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
                            calls.append({key: item.get(key) for key in ["server", "tool", "arguments", "status", "error"]})
                    (directory / "agent-summary.json").write_text(json.dumps({
                        "requested_model": config["model"], "reasoning": config["reasoning"],
                        "usage": usage, "calls": calls,
                        "answer_path": str(setup / "answer.txt"),
                        "target_sha256_before": before_digest,
                        "target_sha256_after": hashlib.sha256(Path(target["path"]).read_bytes()).hexdigest(),
                        "correctness": "requires_source_oracle_review",
                    }, indent=2) + "\n")
                print(json.dumps({"mode": args.mode, "target": target["id"], "lane": lane,
                                  "trial": trial + 1, **result}), flush=True)


if __name__ == "__main__":
    main()
