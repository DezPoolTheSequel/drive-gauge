# Drive Gauge helper - long-lived worker that answers drive questions for the Stream Deck plugin.
# Protocol: one JSON request per stdin line, one JSON response per stdout line.
#   {"id":1,"cmd":"list"}
#   {"id":2,"cmd":"usage","paths":["Z:\\","\\\\nas\\media\\"],"timeout":4000}
# Runs in the same Windows session as Stream Deck, so it sees the same mapped drives you do.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class DgProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetDiskFreeSpaceEx(string dir, out ulong freeAvail, out ulong total, out ulong totalFree);

    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    static extern int WNetGetConnection(string local, StringBuilder remote, ref int len);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetVolumeInformation(string root, StringBuilder volName, int volNameSize,
        out uint serial, out uint maxComp, out uint flags, StringBuilder fsName, int fsNameSize);

    [DllImport("kernel32.dll")]
    static extern uint GetLogicalDrives();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetDriveType(string root);

    [DllImport("kernel32.dll")]
    static extern uint SetErrorMode(uint mode);

    public static void Init() { SetErrorMode(0x0001 | 0x8000); } // no "insert disk" popups

    public class Usage
    {
        public string Path;
        public bool Ok;
        public string Error;
        public ulong Total;
        public ulong Free;      // free space available to this user (respects quotas)
    }

    public class Drive
    {
        public string Letter;   // "Z:"
        public string Root;     // "Z:\"
        public string Type;     // local | network | removable | optical | ram | unknown
        public string Label;    // volume label
        public string Unc;      // \\server\share for mapped drives
        public string FileSystem;
        public bool Ready;
        public ulong Total;
        public ulong Free;
    }

    static string NormalizeRoot(string p)
    {
        if (string.IsNullOrEmpty(p)) return p;
        p = p.Trim().Replace('/', '\\');
        if (p.Length == 2 && p[1] == ':') p += "\\";
        if (!p.EndsWith("\\")) p += "\\";
        return p;
    }

    static Usage UsageNow(string path)
    {
        Usage u = new Usage();
        u.Path = path;
        ulong avail, total, totalFree;
        if (GetDiskFreeSpaceEx(NormalizeRoot(path), out avail, out total, out totalFree))
        {
            u.Ok = true; u.Total = total; u.Free = avail;
        }
        else
        {
            u.Ok = false; u.Error = "win32 error " + Marshal.GetLastWin32Error();
        }
        return u;
    }

    // Each probe runs on its own task so a dead NAS can never wedge the worker.
    public static Usage[] GetUsage(string[] paths, int timeoutMs)
    {
        Task<Usage>[] tasks = new Task<Usage>[paths.Length];
        for (int i = 0; i < paths.Length; i++)
        {
            string p = paths[i];
            tasks[i] = Task.Run(() => UsageNow(p));
        }
        try { Task.WaitAll(tasks, timeoutMs); } catch { }
        Usage[] result = new Usage[paths.Length];
        for (int i = 0; i < paths.Length; i++)
        {
            if (tasks[i].Status == TaskStatus.RanToCompletion) result[i] = tasks[i].Result;
            else
            {
                Usage u = new Usage();
                u.Path = paths[i]; u.Ok = false; u.Error = tasks[i].IsFaulted ? "error" : "timeout";
                result[i] = u;
            }
        }
        return result;
    }

    static string TypeName(uint t)
    {
        switch (t)
        {
            case 2: return "removable";
            case 3: return "local";
            case 4: return "network";
            case 5: return "optical";
            case 6: return "ram";
            default: return "unknown";
        }
    }

    static Drive Describe(char letter)
    {
        Drive d = new Drive();
        d.Letter = letter + ":";
        d.Root = letter + ":\\";
        d.Type = TypeName(GetDriveType(d.Root));
        if (d.Type == "network")
        {
            StringBuilder sb = new StringBuilder(1024);
            int len = sb.Capacity;
            if (WNetGetConnection(d.Letter, sb, ref len) == 0) d.Unc = sb.ToString();
        }
        StringBuilder vol = new StringBuilder(261), fs = new StringBuilder(261);
        uint serial, maxComp, flags;
        if (GetVolumeInformation(d.Root, vol, vol.Capacity, out serial, out maxComp, out flags, fs, fs.Capacity))
        {
            d.Label = vol.ToString();
            d.FileSystem = fs.ToString();
        }
        Usage u = UsageNow(d.Root);
        d.Ready = u.Ok;
        d.Total = u.Total;
        d.Free = u.Free;
        return d;
    }

    public static Drive[] List(int timeoutMs)
    {
        uint mask = GetLogicalDrives();
        List<char> letters = new List<char>();
        for (int i = 0; i < 26; i++) if ((mask & (1u << i)) != 0) letters.Add((char)('A' + i));

        Task<Drive>[] tasks = new Task<Drive>[letters.Count];
        for (int i = 0; i < letters.Count; i++)
        {
            char c = letters[i];
            tasks[i] = Task.Run(() => Describe(c));
        }
        try { Task.WaitAll(tasks, timeoutMs); } catch { }

        List<Drive> result = new List<Drive>();
        for (int i = 0; i < letters.Count; i++)
        {
            if (tasks[i].Status == TaskStatus.RanToCompletion) { result.Add(tasks[i].Result); continue; }
            // Slow/unresponsive drive: still list it, just without details.
            Drive d = new Drive();
            d.Letter = letters[i] + ":";
            d.Root = letters[i] + ":\\";
            d.Type = TypeName(GetDriveType(d.Root));
            if (d.Type == "network")
            {
                StringBuilder sb = new StringBuilder(1024);
                int len = sb.Capacity;
                if (WNetGetConnection(d.Letter, sb, ref len) == 0) d.Unc = sb.ToString();
            }
            d.Ready = false;
            result.Add(d);
        }
        return result.ToArray();
    }
}
'@

try { [DgProbe]::Init() } catch { }

function Send($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

Send @{ id = 0; ready = $true; ps = $PSVersionTable.PSVersion.ToString() }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }      # Stream Deck closed the pipe
    if ($line.Trim() -eq '') { continue }
    $id = -1
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $timeout = 4000
        if ($req.timeout) { $timeout = [int]$req.timeout }

        switch ($req.cmd) {
            'list' {
                $drives = @([DgProbe]::List($timeout))
                $letters = @($drives | ForEach-Object { $_.Letter })
                # Persistent mappings that are currently disconnected (red X in Explorer)
                $extra = @()
                if (Test-Path 'HKCU:\Network') {
                    foreach ($k in Get-ChildItem 'HKCU:\Network' -ErrorAction SilentlyContinue) {
                        $letter = ($k.PSChildName.ToUpper() + ':')
                        if ($letters -notcontains $letter) {
                            $remote = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).RemotePath
                            $extra += [pscustomobject]@{
                                Letter = $letter; Root = ($letter + '\'); Type = 'network'; Label = $null
                                Unc = $remote; FileSystem = $null; Ready = $false; Total = 0; Free = 0
                            }
                        }
                    }
                }
                Send @{ id = $id; ok = $true; drives = @($drives + $extra) }
            }
            'usage' {
                $paths = [string[]]@($req.paths)
                $res = @([DgProbe]::GetUsage($paths, $timeout))
                Send @{ id = $id; ok = $true; usage = $res }
            }
            'ping' { Send @{ id = $id; ok = $true } }
            default { Send @{ id = $id; ok = $false; error = "unknown cmd $($req.cmd)" } }
        }
    }
    catch {
        Send @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
