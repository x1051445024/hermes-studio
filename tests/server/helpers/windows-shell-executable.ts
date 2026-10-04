import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STUB = join(tmpdir(), 'ekko-studio-shell-relay-v3.exe')
const SOURCE = join(tmpdir(), 'ekko-studio-shell-relay-v3.cs')
const RUNNER = join(tmpdir(), 'ekko-studio-shell-relay-v3.sh')
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

const RUNNER_SCRIPT = `#!/bin/sh
set -eu
args_file=$1
script=$2
if command -v cygpath >/dev/null 2>&1; then
  args_file=$(cygpath -u "$args_file")
  script=$(cygpath -u "$script")
  if [ -n "\${HERMES_HOME:-}" ]; then
    HERMES_HOME=$(cygpath -u "$HERMES_HOME")
    export HERMES_HOME
  fi
fi
set --
while IFS= read -r -d '' arg; do
  set -- "$@" "$arg"
done < "$args_file"
exec "$script" "$@"
`

function bashPath(): string {
  const found = BASH_CANDIDATES.find(candidate => existsSync(candidate))
  if (!found) throw new Error('Git Bash is required to execute POSIX Python fixtures on Windows')
  return found
}

function ensureRelay(): void {
  if (!existsSync(RUNNER)) writeFileSync(RUNNER, RUNNER_SCRIPT)
  if (existsSync(STUB)) return
  const program = `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public class ShellRelay {
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JobObjectLimitKillOnJobClose = 0x2000;

  [StructLayout(LayoutKind.Sequential)]
  private struct JobObjectBasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JobObjectExtendedLimitInformationStruct {
    public JobObjectBasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  private static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var limits = new JobObjectExtendedLimitInformationStruct();
    limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
    IntPtr memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobObjectExtendedLimitInformationStruct)));
    try {
      Marshal.StructureToPtr(limits, memory, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, memory,
          (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformationStruct)))) {
        throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
      }
      return job;
    } catch {
      CloseHandle(job);
      throw;
    } finally {
      Marshal.FreeHGlobal(memory);
    }
  }

  private static string QuoteArgument(string value) {
    return "\\\"" + value + "\\\"";
  }

  public static int Main(string[] args) {
    string exe = Environment.GetCommandLineArgs()[0];
    string script = Path.Combine(Path.GetDirectoryName(exe), Path.GetFileNameWithoutExtension(exe));
    string argsFile = script + ".args";
    IntPtr job = IntPtr.Zero;
    Process process = null;
    try {
      using (var stream = File.Create(argsFile)) {
        foreach (string arg in args) {
          byte[] bytes = Encoding.UTF8.GetBytes(arg);
          stream.Write(bytes, 0, bytes.Length);
          stream.WriteByte(0);
        }
      }

      job = CreateKillOnCloseJob();
      var start = new ProcessStartInfo();
      start.FileName = "${bashPath().replace(/\\/g, '\\\\')}";
      start.Arguments = QuoteArgument("${RUNNER.replace(/\\/g, '\\\\')}") + " " +
        QuoteArgument(argsFile) + " " + QuoteArgument(script);
      start.UseShellExecute = false;
      start.RedirectStandardOutput = true;
      start.RedirectStandardError = true;
      start.CreateNoWindow = true;
      process = Process.Start(start);
      if (process == null || !AssignProcessToJobObject(job, process.Handle)) {
        throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
      }
      Task<string> error = Task.Run(() => process.StandardError.ReadToEnd());
      string output = process.StandardOutput.ReadToEnd();
      error.Wait();
      process.WaitForExit();
      Console.OutputEncoding = Encoding.UTF8;
      Console.Out.Write(output);
      return process.ExitCode;
    } finally {
      if (process != null) {
        try { if (!process.HasExited) process.Kill(); } catch {}
        try { process.Dispose(); } catch {}
      }
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
`
  writeFileSync(SOURCE, program)
  execFileSync(COMPILER, ['/nologo', '/t:exe', `/out:${STUB}`, SOURCE], { windowsHide: true })
}

export function materializeShellExecutable(scriptPath: string): string {
  if (process.platform !== 'win32') return scriptPath
  ensureRelay()
  const exePath = /\.exe$/i.test(scriptPath) ? scriptPath : `${scriptPath}.exe`
  copyFileSync(STUB, exePath)
  return exePath
}
