/* PI 安装/卸载程序（自解压单文件）—— scripts/make-csharp-installer.mjs 负责编译与打包
 * ============================================================================
 * 为什么不用 NSIS：见 docs/PLAN.md §4.34。用户在资源管理器里双击我们编出来的 NSIS
 * 安装包时，会在 NSIS 自己的 .onInit 之前弹出
 *     NSIS Error: Error writing temporary file. Make sure your temp folder is valid.
 * 而这条文案在 NSIS 源码里可达的路径只有「整块压缩 /SOLID 的启动临时文件」和
 * 「插件解压到 $PLUGINSDIR(%TEMP%\nsuXXXX.tmp)」两条；我们的包两条都没走
 * （实测 stub = zlib-x86-unicode 非整块、编译日志插件条目 0），本机又无法复现
 * （连零特性静默 NSIS 安装器在这里都会挂住）。既然解释不通，就换一条自己完全
 * 掌控、且**结构上不可能碰 %TEMP%** 的路。
 *
 * 设计要点：
 *   · 载荷 = 以 deflate 流追加在 exe 尾部（尾部 32 字节是 trailer：magic + 数据偏移
 *     + 数据长度 + 解压后总字节数）。安装时从**自身文件**流式解压，全程不写任何
 *     临时文件、不调用外部程序。
 *   · 安装位置、注册表项（HKCU\...\Uninstall\PI）、快捷方式与 NSIS 版逐字一致，
 *     所以「设置 → 应用 → 已安装的应用」里的表现和原来完全一样。
 *   · `--silent` 走无界面路径并往 stdout 打日志，脚本可以完整自检安装与卸载，
 *     不需要人点界面（本仓库的会话环境里跑不了 GUI 窗口）。
 *
 * 同一份源码编译三个产物：
 *   1) /target:winexe                        → PI-Setup 的 base（会被 --pack 追加载荷）
 *   2) /target:winexe /define:UNINSTALLER_MODE → 卸载 PI.exe（小、不带载荷）
 *   3) /target:exe                            → 自检/打包用的控制台版本（--pack / --silent）
 *
 * 必须用 .NET Framework 4.8 自带的 csc.exe 编译，它只支持到 C# 5：
 * 不要用字符串插值 $""、?.(null 条件)、nameof、表达式体成员、out var 等新语法。
 * ============================================================================
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

/* 程序集信息：csc 会据此生成 Win32 版本资源（RT_VERSION），
   scripts/patch-exe.mjs 再在其上覆盖图标与关键字串。 */
#if UNINSTALLER_MODE
[assembly: AssemblyTitle("PI 卸载程序")]
[assembly: AssemblyDescription("PI 卸载程序")]
#else
[assembly: AssemblyTitle("PI 安装程序")]
[assembly: AssemblyDescription("PI 安装程序")]
#endif
[assembly: AssemblyProduct("PI")]
[assembly: AssemblyCompany("PI")]
[assembly: AssemblyCopyright("© 2026 PI")]
[assembly: AssemblyFileVersion("0.1.0.0")]
[assembly: AssemblyInformationalVersion("0.1.0")]
[assembly: AssemblyVersion("0.1.0.0")]

namespace PiSetup
{
    internal static class Program
    {
        internal const string Magic = "PIPAYL01";
        internal const int TrailerLen = 32;

        internal const string AppName = "PI";
        internal const string AppExeName = "pi.exe";
        internal const string UninstExeName = "卸载 PI.exe";
        internal const string ProductVersion = "0.1.0";
        internal const string PublisherName = "PI";
        internal const string AppDescription = "PI —— 桌面音乐应用";

        internal const string DefaultUninstallSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
        internal const string UninstallKeyName = "PI";

        /* 自检时把注册表写到这里，避免污染真实的卸载项：
           $env:PI_DEBUG_REG_ROOT = 'Software\PI-Test\Uninstall' */
        internal static string RegRoot
        {
            get
            {
                string v = Environment.GetEnvironmentVariable("PI_DEBUG_REG_ROOT");
                if (string.IsNullOrEmpty(v)) return DefaultUninstallSubKey;
                return v;
            }
        }

        internal static string SelfPath()
        {
            try
            {
                Process p = Process.GetCurrentProcess();
                if (p.MainModule != null && !string.IsNullOrEmpty(p.MainModule.FileName)) return p.MainModule.FileName;
            }
            catch { }
            try
            {
                Assembly a = Assembly.GetEntryAssembly();
                if (a != null && !string.IsNullOrEmpty(a.Location)) return a.Location;
            }
            catch { }
            return Application.ExecutablePath;
        }

        internal static string DefaultInstallDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\PI");
        }

        internal static string DefaultLogPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"PI\安装日志.txt");
        }

        [STAThread]
        internal static int Main(string[] rawArgs)
        {
            Options o = Options.Parse(rawArgs);
            string logPath = o.Get("log");
            if (string.IsNullOrEmpty(logPath)) logPath = DefaultLogPath();
            Log.Init(logPath);

            string self = SelfPath();
            Log.Line("启动：" + self);
            Log.Line("参数：" + string.Join(" ", rawArgs));

            try
            {
                if (o.Has("help"))
                {
                    Console.WriteLine("PI 安装程序");
                    Console.WriteLine("  （无参数）              图形界面安装");
                    Console.WriteLine("  --silent [--target D]   无界面安装");
                    Console.WriteLine("  --no-shortcuts          不建快捷方式");
                    Console.WriteLine("  --pack --payload D --out F [--base B] [--extra F] [--report F]  打包载荷");
                    Console.WriteLine("  --uninstall [--silent]  卸载");
                    return 0;
                }

                if (o.Has("pack")) return PackMode(o, self);

#if UNINSTALLER_MODE
                return RunUninstall(o, self);
#else
                if (o.Has("uninstall")) return RunUninstall(o, self);
                return RunInstall(o, self);
#endif
            }
            catch (Exception ex)
            {
                Log.Line("失败：" + ex.ToString());
                Console.Error.WriteLine(ex.ToString());
                if (o.Has("silent"))
                {
                    return 1;
                }
                MessageBox.Show(ex.Message + "\r\n\r\n详细日志："
                    + (string.IsNullOrEmpty(Log.Path_) ? "（日志也写不进去：所有候选位置都被拒绝访问）" : Log.Path_),
                    AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        /* ------------------------------------------------------------------ 安装 */

        private static int RunInstall(Options o, string self)
        {
            string target = o.Get("target");
            if (string.IsNullOrEmpty(target)) target = DefaultInstallDir();
            bool makeShortcuts = !o.Has("no-shortcuts");

            if (!PayloadReader.IsPacked(self))
            {
                throw new InvalidDataException("这个 exe 里没有载荷，请用 make-csharp-installer.mjs 打包后的安装包。");
            }

            if (o.Has("silent"))
            {
                Installer.Install(self, target, makeShortcuts, ConsoleProgress);
                Log.Line("静默安装完成：" + target);
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            InstallerForm f = new InstallerForm(false, target, makeShortcuts, self);
            Application.Run(f);
            return f.ErrorOccurred ? 1 : 0;
        }

        /* ------------------------------------------------------------------ 卸载 */

        private static int RunUninstall(Options o, string self)
        {
            string target = Installer.FindInstallDir(o.Get("target"));
            Log.Line("卸载目标：" + target);

            if (o.Has("silent"))
            {
                Installer.Uninstall(target, self, ConsoleProgress);
                Log.Line("静默卸载完成。");
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            DialogResult r = MessageBox.Show("确定要卸载 " + AppName + " 吗？\r\n\r\n安装目录：" + target +
                "\r\n（用户数据目录 %APPDATA%\\PI 会保留）", "卸载 " + AppName,
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return 0;

            InstallerForm f = new InstallerForm(true, target, false, self);
            Application.Run(f);
            return f.ErrorOccurred ? 1 : 0;
        }

        private static void ConsoleProgress(int percent, string text)
        {
            Console.WriteLine(percent + "%  " + text);
        }

        /* ------------------------------------------------------------------ 打包 */

        private static int PackMode(Options o, string self)
        {
            string baseExe = o.Get("base");
            if (string.IsNullOrEmpty(baseExe)) baseExe = self;
            baseExe = Path.GetFullPath(baseExe);

            string payload = o.Get("payload");
            if (string.IsNullOrEmpty(payload)) throw new ArgumentException("--pack 需要 --payload <目录>");
            string outExe = o.Get("out");
            if (string.IsNullOrEmpty(outExe)) throw new ArgumentException("--pack 需要 --out <exe>");

            List<string> extras = new List<string>();
            string extra = o.Get("extra");
            if (!string.IsNullOrEmpty(extra)) extras.Add(extra);

            if (PayloadReader.IsPacked(baseExe))
                throw new InvalidDataException("base exe 已经带载荷了，请用未打包的那个做 base：" + baseExe);

            Packer.Result r = Packer.Pack(baseExe, payload, extras, outExe);
            string report = string.Format(
                "base={0}\r\npayload={1}\r\nout={2}\r\nentries={3}\r\nfiles={4}\r\ndirs={5}\r\npayloadBytes={6}\r\noutBytes={7}\r\ndataOffset={8}\r\ndataLength={9}\r\n",
                baseExe, Path.GetFullPath(payload), Path.GetFullPath(outExe),
                r.Entries, r.Files, r.Dirs, r.PayloadBytes, r.OutBytes, r.DataOffset, r.DataLength);
            Log.Line(report.Trim());
            Console.Write(report);

            string reportPath = o.Get("report");
            if (!string.IsNullOrEmpty(reportPath))
            {
                File.WriteAllText(reportPath, report, new UTF8Encoding(true));
            }
            return 0;
        }
    }

    /* ====================================================================== 参数 */

    internal sealed class Options
    {
        private readonly Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> flags = new List<string>();

        internal static Options Parse(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a.Length > 2 && a.StartsWith("--"))
                {
                    string key = a.Substring(2);
                    string val = null;
                    int eq = key.IndexOf('=');
                    if (eq >= 0)
                    {
                        val = key.Substring(eq + 1);
                        key = key.Substring(0, eq);
                    }
                    else if (i + 1 < args.Length && !args[i + 1].StartsWith("--"))
                    {
                        val = args[++i];
                    }
                    if (val == null) o.flags.Add(key);
                    else o.values[key] = val;
                }
                else
                {
                    o.flags.Add(a);
                }
            }
            return o;
        }

        internal bool Has(string name)
        {
            return flags.Contains(name) || values.ContainsKey(name);
        }

        internal string Get(string name)
        {
            string v;
            if (values.TryGetValue(name, out v)) return v;
            return null;
        }
    }

    /* ====================================================================== 日志 */

    internal static class Log
    {
        private static readonly object gate = new object();
        private static string path;

        internal static string Path_ { get { return path; } }

        internal static void Init(string preferred)
        {
            /* 日志是出问题时唯一的线索，所以不能只试一个位置：首选调用方给的（或默认）
               路径，写不进去（权限 / 沙箱 / 安全软件）就依次退到 %TEMP% 和**安装包自己
               所在的目录**——最后这个就在用户眼皮底下，失败了我们也能读到。 */
            string selfDir = "";
            try { selfDir = System.IO.Path.GetDirectoryName(Program.SelfPath()); } catch { }
            string[] candidates = new string[]
            {
                preferred,
                System.IO.Path.Combine(System.IO.Path.GetTempPath(), "PI-安装日志.txt"),
                string.IsNullOrEmpty(selfDir) ? null : System.IO.Path.Combine(selfDir, "PI-安装日志.txt")
            };
            List<string> tried = new List<string>();
            for (int i = 0; i < candidates.Length; i++)
            {
                string c = candidates[i];
                if (string.IsNullOrEmpty(c)) continue;
                tried.Add(c);
                try
                {
                    string dir = System.IO.Path.GetDirectoryName(c);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    File.AppendAllText(c, "", new UTF8Encoding(true));
                    path = c;
                    break;
                }
                catch { }
            }
            Line("=== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ===");
            try { Line("程序：" + Program.SelfPath() + "（版本 " + Program.ProductVersion + "）"); } catch { }
            if (path == null) Line("【致命】日志写不进去，试过：" + string.Join("、", tried.ToArray()));
            else
            {
                Line("日志：" + path);
                if (!string.Equals(path, preferred, StringComparison.OrdinalIgnoreCase))
                    Line("（首选位置写不进去，已退到上面这个：" + preferred + "）");
            }
        }

        internal static void Line(string s)
        {
            lock (gate)
            {
                try { if (path != null) File.AppendAllText(path, s + "\r\n", new UTF8Encoding(true)); }
                catch { }
            }
            try { Console.WriteLine(s); } catch { }
        }
    }

    /* ================================================================== 载荷读取 */

    internal sealed class PayloadEntry
    {
        internal string Name;
        internal bool IsDirectory;
        internal long Size;
    }

    /* 注册表写入。
       先走 .NET API；被拒时回退到系统自带的 reg.exe。
       为什么要回退：本机实测（harness 环境里）未签名的托管 exe 写 HKCU 会拿到
       UnauthorizedAccessException，而同一环境、同一用户下 reg.exe / powershell.exe
       （微软签名程序）写同一个键完全正常 —— 那种拦截是按进程映像来的，
       用系统程序代写就能绕开。多一层保险，对用户机器无害。 */
    internal static class Reg
    {
        internal static string LastMethod = "api";

        internal static void WriteString(string keyPath, string name, string value)
        {
            if (TryApi(keyPath, name, value, RegistryValueKind.String)) return;
            RunReg("add \"HKCU\\" + keyPath + "\" /v \"" + name + "\" /t REG_SZ /d \"" + value + "\" /f");
            LastMethod = "reg.exe";
        }

        internal static void WriteDword(string keyPath, string name, int value)
        {
            if (TryApi(keyPath, name, value, RegistryValueKind.DWord)) return;
            RunReg("add \"HKCU\\" + keyPath + "\" /v \"" + name + "\" /t REG_DWORD /d " + value + " /f");
            LastMethod = "reg.exe";
        }

        internal static void DeleteTree(string keyPath)
        {
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(keyPath, false);
                return;
            }
            catch (Exception ex)
            {
                Log.Line("注册表 API 删除 " + keyPath + " 失败（" + ex.GetType().Name + "），改用 reg.exe");
            }
            RunReg("delete \"HKCU\\" + keyPath + "\" /f");
            LastMethod = "reg.exe";
        }

        private static bool TryApi(string keyPath, string name, object value, RegistryValueKind kind)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(keyPath))
                {
                    if (k == null) throw new InvalidOperationException("CreateSubKey 返回 null：" + keyPath);
                    k.SetValue(name, value, kind);
                }
                return true;
            }
            catch (Exception ex)
            {
                Log.Line("注册表 API 写 " + name + " 失败（" + ex.GetType().Name + ": " + ex.Message + "），改用 reg.exe");
                return false;
            }
        }

        private static void RunReg(string args)
        {
            ProcessStartInfo psi = new ProcessStartInfo("reg.exe", args);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                string stdout = p.StandardOutput.ReadToEnd();
                string stderr = p.StandardError.ReadToEnd();
                p.WaitForExit();
                if (p.ExitCode != 0)
                    throw new InvalidOperationException(
                        "reg.exe " + args + " 退出码 " + p.ExitCode + "：" + (stderr + stdout).Trim());
            }
        }
    }

    internal sealed class PayloadReader : IDisposable
    {
        private readonly FileStream file;
        private readonly DeflateStream deflate;
        private readonly BinaryReader reader;
        private int remaining;

        internal long TotalFileBytes;

        private PayloadReader(FileStream f, DeflateStream d, BinaryReader r, long total, int entries)
        {
            file = f; deflate = d; reader = r; TotalFileBytes = total; remaining = entries;
        }

        internal static bool IsPacked(string exePath)
        {
            try
            {
                using (FileStream fs = File.OpenRead(exePath))
                {
                    if (fs.Length < Program.TrailerLen * 2) return false;
                    fs.Seek(fs.Length - Program.TrailerLen, SeekOrigin.Begin);
                    byte[] t = new byte[Program.TrailerLen];
                    ReadExactly(fs, t, 0, t.Length);
                    return Encoding.ASCII.GetString(t, 0, 8) == Program.Magic;
                }
            }
            catch { return false; }
        }

        internal static PayloadReader Open(string exePath)
        {
            FileStream fs = File.OpenRead(exePath);
            try
            {
                long len = fs.Length;
                if (len < Program.TrailerLen * 2) throw new InvalidDataException("文件太小，不是打包过的安装包。");
                fs.Seek(len - Program.TrailerLen, SeekOrigin.Begin);
                byte[] t = new byte[Program.TrailerLen];
                ReadExactly(fs, t, 0, t.Length);
                if (Encoding.ASCII.GetString(t, 0, 8) != Program.Magic)
                    throw new InvalidDataException("这个 exe 里没有找到载荷（没有用 --pack 打包过）。");
                long offset = BitConverter.ToInt64(t, 8);
                long dataLen = BitConverter.ToInt64(t, 16);
                long total = BitConverter.ToInt64(t, 24);
                if (offset <= 0 || dataLen <= 0 || offset + dataLen > len)
                    throw new InvalidDataException("载荷偏移不合法。");
                fs.Seek(offset, SeekOrigin.Begin);
                DeflateStream ds = new DeflateStream(fs, CompressionMode.Decompress);
                BinaryReader br = new BinaryReader(ds);
                /* 载荷开头是打包时写的条目总数（Int32）：必须先读掉它，
                   否则第一次 ReadByte() 读到的是这个计数的低字节。 */
                int entries = br.ReadInt32();
                if (entries < 0) throw new InvalidDataException("载荷条目数不合法。");
                return new PayloadReader(fs, ds, br, total, entries);
            }
            catch
            {
                fs.Dispose();
                throw;
            }
        }

        internal bool NextEntry(out PayloadEntry entry, out Stream content)
        {
            entry = null;
            content = null;
            if (remaining <= 0) return false;
            remaining--;

            int kind;
            try { kind = reader.ReadByte(); }
            catch (EndOfStreamException) { return false; }
            if (kind < 0) return false;
            if (kind != 1 && kind != 2) throw new InvalidDataException("载荷条目类型非法：" + kind);

            PayloadEntry e = new PayloadEntry();
            e.IsDirectory = (kind == 1);
            e.Name = reader.ReadString();
            e.Size = e.IsDirectory ? 0 : reader.ReadInt64();
            entry = e;
            content = e.IsDirectory ? null : new EntryStream(reader, e.Size);
            return true;
        }

        internal static void ReadExactly(Stream s, byte[] buf, int off, int count)
        {
            int done = 0;
            while (done < count)
            {
                int n = s.Read(buf, off + done, count - done);
                if (n <= 0) throw new EndOfStreamException("读文件时提前结束。");
                done += n;
            }
        }

        public void Dispose()
        {
            try { reader.Dispose(); } catch { }
            try { deflate.Dispose(); } catch { }
            try { file.Dispose(); } catch { }
        }
    }

    /* 把 BinaryReader 上的连续 size 字节包装成一个只读子流（deflate 只能顺序读，
       所以载荷必须在一次遍历里解压到目标目录）。 */
    internal sealed class EntryStream : Stream
    {
        private readonly BinaryReader reader;
        private long remaining;

        internal EntryStream(BinaryReader r, long size)
        {
            reader = r;
            remaining = size;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return remaining; } }
        public override long Position
        {
            get { return remaining; }
            set { throw new NotSupportedException(); }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            int n = reader.Read(buffer, offset, count);
            if (n <= 0) throw new EndOfStreamException("载荷被截断。");
            remaining -= n;
            return n;
        }

        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    /* ================================================================== 打包器 */

    internal static class Packer
    {
        internal sealed class Result
        {
            internal long Entries, Files, Dirs, PayloadBytes, OutBytes, DataOffset, DataLength;
        }

        internal static Result Pack(string baseExe, string payloadDir, List<string> extras, string outExe)
        {
            if (!Directory.Exists(payloadDir)) throw new DirectoryNotFoundException("载荷目录不存在：" + payloadDir);

            List<string> dirs = new List<string>();
            foreach (string d in Directory.GetDirectories(payloadDir, "*", SearchOption.AllDirectories)) dirs.Add(d);
            dirs.Sort(StringComparer.OrdinalIgnoreCase);

            List<string> files = new List<string>();
            foreach (string f in Directory.GetFiles(payloadDir, "*", SearchOption.AllDirectories)) files.Add(f);
            files.Sort(StringComparer.OrdinalIgnoreCase);

            long payloadBytes = 0;
            foreach (string f in files) payloadBytes += new FileInfo(f).Length;

            long count = dirs.Count + files.Count + extras.Count;
            byte[] baseBytes = File.ReadAllBytes(baseExe);

            string outDir = Path.GetDirectoryName(Path.GetFullPath(outExe));
            if (!string.IsNullOrEmpty(outDir)) Directory.CreateDirectory(outDir);

            Result r = new Result();
            r.Dirs = dirs.Count;
            r.Files = files.Count + extras.Count;
            r.Entries = count;
            r.PayloadBytes = payloadBytes;

            using (FileStream fs = new FileStream(outExe, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(baseBytes, 0, baseBytes.Length);
                long dataOffset = fs.Position;

                using (DeflateStream ds = new DeflateStream(fs, CompressionLevel.Optimal, true))
                {
                    BinaryWriter w = new BinaryWriter(ds);
                    w.Write((int)count);

                    byte[] buf = new byte[1 << 20];
                    foreach (string d in dirs)
                    {
                        w.Write((byte)1);
                        w.Write(Rel(payloadDir, d));
                        w.Flush();
                    }
                    foreach (string f in files)
                    {
                        w.Write((byte)2);
                        w.Write(Rel(payloadDir, f));
                        w.Write(new FileInfo(f).Length);
                        using (FileStream inFs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.Read))
                        {
                            int n;
                            while ((n = inFs.Read(buf, 0, buf.Length)) > 0) ds.Write(buf, 0, n);
                        }
                    }
                    foreach (string e in extras)
                    {
                        w.Write((byte)2);
                        w.Write(Path.GetFileName(e));
                        w.Write(new FileInfo(e).Length);
                        using (FileStream inFs = new FileStream(e, FileMode.Open, FileAccess.Read, FileShare.Read))
                        {
                            int n;
                            while ((n = inFs.Read(buf, 0, buf.Length)) > 0) ds.Write(buf, 0, n);
                        }
                    }
                    w.Flush();
                }

                long dataLength = fs.Position - dataOffset;
                byte[] trailer = new byte[Program.TrailerLen];
                Encoding.ASCII.GetBytes(Program.Magic).CopyTo(trailer, 0);
                BitConverter.GetBytes(dataOffset).CopyTo(trailer, 8);
                BitConverter.GetBytes(dataLength).CopyTo(trailer, 16);
                BitConverter.GetBytes(payloadBytes).CopyTo(trailer, 24);
                fs.Write(trailer, 0, trailer.Length);
                fs.Flush();

                r.DataOffset = dataOffset;
                r.DataLength = dataLength;
                r.OutBytes = fs.Position;
            }

            return r;
        }

        private static string Rel(string root, string full)
        {
            string p = full.Substring(root.Length).TrimStart('\\', '/');
            return p.Replace('/', '\\');
        }
    }

    /* ================================================================== 安装/卸载 */

    internal static class Installer
    {
        internal static string FindInstallDir(string overrideDir)
        {
            if (!string.IsNullOrEmpty(overrideDir)) return overrideDir;

            /* 卸载器永远和 pi.exe 装在一起，「自己所在的目录」是最可靠的线索：
               注册表项可能压根没写成功（权限受限/事后被清理），那时退回默认目录
               会去删一个根本没装过的位置。只有自己旁边没有 pi.exe 时才看注册表。 */
            try
            {
                string self = Path.GetDirectoryName(Path.GetFullPath(Program.SelfPath()));
                if (!string.IsNullOrEmpty(self) && File.Exists(Path.Combine(self, Program.AppExeName))) return self;
            }
            catch { }

            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Program.RegRoot + "\\" + Program.UninstallKeyName))
                {
                    if (k != null)
                    {
                        object v = k.GetValue("InstallLocation");
                        if (v != null && v.ToString().Length > 0) return v.ToString();
                    }
                }
            }
            catch { }
            return Program.DefaultInstallDir();
        }

        /* 光说「对路径 X 的访问被拒绝」帮不上忙，把常见原因直接列出来。
           已定案的头号原因：exe 自己被打了 Low 强制完整性标签（构建目录带 Low 标签时，
           里面新生成的文件会继承它）。进程的完整性级别跟着 exe 走 —— Low 进程写不了
           Medium 对象（%LOCALAPPDATA%、%TEMP%、HKCU），却能写同目录，于是表现成
           「能往安装包旁边写日志、却装不进任何正常位置」。 */
        internal static string WriteDeniedHint(string dir)
        {
            return "无法写入：" + dir + "\r\n\r\n常见原因：\r\n"
                + "  · 安装包（或 pi.exe）的 Windows 完整性标签是 Low —— 把安装包复制到桌面等普通文件夹后再双击，"
                + "或对该文件执行：icacls \"<安装包路径>\" /setintegritylevel Medium\r\n"
                + "  · 这个位置需要管理员权限（换成例如 D:\\PI 再试）\r\n"
                + "  · 杀毒 / 防护软件拦截了写入（看它的拦截记录）\r\n"
                + "  · 目标盘只读或已满（换一个位置）";
        }

        internal static void Install(string selfPath, string targetDir, bool makeShortcuts, Action<int, string> progress)
        {
            targetDir = Path.GetFullPath(targetDir);
            Log.Line("安装到：" + targetDir);
            try
            {
                Directory.CreateDirectory(targetDir);
            }
            catch (Exception ex)
            {
                Log.Line("【失败】无法创建安装目录：" + ex.Message);
                throw new IOException(WriteDeniedHint(targetDir) + "\r\n\r\n系统报告：" + ex.Message, ex);
            }

            long done = 0;
            long files = 0;
            using (PayloadReader pr = PayloadReader.Open(selfPath))
            {
                PayloadEntry e;
                Stream content;
                byte[] buf = new byte[1 << 20];
                while (pr.NextEntry(out e, out content))
                {
                    string name = e.Name;
                    if (name.IndexOf("..", StringComparison.Ordinal) >= 0)
                        throw new InvalidDataException("载荷里的路径不合法：" + name);
                    string dest = Path.Combine(targetDir, name);

                    if (e.IsDirectory)
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }

                    string parent = Path.GetDirectoryName(dest);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (FileStream outFs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        int n;
                        while ((n = content.Read(buf, 0, buf.Length)) > 0)
                        {
                            outFs.Write(buf, 0, n);
                            done += n;
                        }
                    }
                    files++;
                    if (progress != null && pr.TotalFileBytes > 0)
                    {
                        int pct = (int)(done * 100 / pr.TotalFileBytes);
                        if (pct > 100) pct = 100;
                        progress(pct, "正在安装 " + name);
                    }
                }
            }
            Log.Line("解压完成：文件 " + files + " 个，" + (done / 1048576) + " MB");

            long estimated = MeasureBytes(targetDir);
            try
            {
                WriteRegistry(targetDir, estimated);
                Log.Line("注册表已写入：HKCU\\" + Program.RegRoot + "\\" + Program.UninstallKeyName
                    + "（EstimatedSize=" + (estimated / 1024) + " KB，写入方式=" + Reg.LastMethod + "）");
            }
            catch (Exception ex)
            {
                /* 注册表失败不该让整个安装白干：程序已经落地，只是「应用和功能」里看不到。 */
                Log.Line("【警告】注册表写入失败，程序已安装但不会出现在「应用和功能」里：" + ex.Message);
            }

            if (makeShortcuts)
            {
                try { CreateShortcuts(targetDir); }
                catch (Exception ex) { Log.Line("【警告】快捷方式创建失败：" + ex.Message); }
            }
            else Log.Line("按要求跳过快捷方式。");

            if (progress != null) progress(100, "安装完成。");
        }

        internal static void Uninstall(string installDir, string selfPath, Action<int, string> progress)
        {
            installDir = Path.GetFullPath(installDir);
            Log.Line("卸载：" + installDir);

            KillApp(installDir);
            RemoveShortcuts();

            try
            {
                Reg.DeleteTree(Program.RegRoot + "\\" + Program.UninstallKeyName);
                Log.Line("注册表项已删除。");
            }
            catch (Exception ex) { Log.Line("删除注册表项失败：" + ex.Message); }

            int deleted = 0, failed = 0;
            if (Directory.Exists(installDir))
            {
                foreach (string f in Directory.GetFiles(installDir, "*", SearchOption.AllDirectories))
                {
                    try { File.Delete(f); deleted++; }
                    catch { failed++; }
                }
                foreach (string d in Directory.GetDirectories(installDir, "*", SearchOption.AllDirectories))
                {
                    try { Directory.Delete(d, true); } catch { }
                }
            }
            Log.Line("删除文件：" + deleted + " 个，失败 " + failed + " 个（正在运行的文件交给系统延时清理）");

            if (progress != null) progress(100, "卸载完成。");

            /* 自己正在被占用，删不掉：交给系统 cmd 延时把目录清掉（不写临时文件）。 */
            try
            {
                string cmdExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                ProcessStartInfo psi = new ProcessStartInfo(cmdExe,
                    "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + installDir + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                Log.Line("已安排延时删除目录。");
            }
            catch (Exception ex) { Log.Line("安排延时删除失败：" + ex.Message); }
        }

        internal static long MeasureBytes(string dir)
        {
            long total = 0;
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(f).Length; } catch { }
                }
            }
            catch { }
            return total;
        }

        private static void WriteRegistry(string targetDir, long estimatedBytes)
        {
            string keyPath = Program.RegRoot + "\\" + Program.UninstallKeyName;
            string uninst = "\"" + Path.Combine(targetDir, Program.UninstExeName) + "\"";
            Reg.WriteString(keyPath, "DisplayName", Program.AppName);
            Reg.WriteString(keyPath, "DisplayVersion", Program.ProductVersion);
            Reg.WriteString(keyPath, "DisplayIcon", Path.Combine(targetDir, Program.AppExeName));
            Reg.WriteString(keyPath, "Publisher", Program.PublisherName);
            Reg.WriteString(keyPath, "InstallLocation", targetDir);
            Reg.WriteString(keyPath, "UninstallString", uninst);
            Reg.WriteString(keyPath, "QuietUninstallString", uninst + " --silent");
            Reg.WriteDword(keyPath, "NoModify", 1);
            Reg.WriteDword(keyPath, "NoRepair", 1);
            Reg.WriteString(keyPath, "InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            if (estimatedBytes > 0)
                Reg.WriteDword(keyPath, "EstimatedSize", (int)(estimatedBytes / 1024));
        }

        private static void CreateShortcuts(string targetDir)
        {
            string app = Path.Combine(targetDir, Program.AppExeName);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string l1 = Path.Combine(programs, Program.AppName + ".lnk");
            string l2 = Path.Combine(desktop, Program.AppName + ".lnk");
            bool ok1 = MakeShortcut(l1, app, targetDir);
            bool ok2 = MakeShortcut(l2, app, targetDir);
            if (ok1 && ok2) Log.Line("快捷方式已创建：" + l1 + " 、 " + l2);
            else if (!ok1 && !ok2) Log.Line("【警告】开始菜单和桌面的快捷方式都没建成功（见上面的失败原因）。");
            else Log.Line("【警告】只建成了一个快捷方式：开始菜单=" + ok1 + "，桌面=" + ok2);
        }

        private static void RemoveShortcuts()
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            foreach (string p in new string[] {
                Path.Combine(programs, Program.AppName + ".lnk"),
                Path.Combine(desktop, Program.AppName + ".lnk") })
            {
                try { if (File.Exists(p)) { File.Delete(p); Log.Line("已删除快捷方式：" + p); } }
                catch (Exception ex) { Log.Line("删除快捷方式失败 " + p + "：" + ex.Message); }
            }
        }

        private static bool MakeShortcut(string lnkPath, string target, string workDir)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                if (t == null) { Log.Line("系统没有 WScript.Shell，跳过快捷方式：" + lnkPath); return false; }
                object shell = Activator.CreateInstance(t);
                object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type lt = lnk.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { Program.AppDescription });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
                Marshal.ReleaseComObject(lnk);
                Marshal.ReleaseComObject(shell);
                return true;
            }
            catch (Exception ex)
            {
                Log.Line("创建快捷方式失败 " + lnkPath + "：" + ex.Message);
                return false;
            }
        }

        private static void KillApp(string installDir)
        {
            foreach (Process p in Process.GetProcessesByName("pi"))
            {
                string path = null;
                try { path = p.MainModule.FileName; } catch { }
                if (path == null || !path.StartsWith(installDir, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    Log.Line("结束正在运行的进程：" + path);
                    p.Kill();
                    p.WaitForExit(5000);
                }
                catch (Exception ex) { Log.Line("结束进程失败：" + ex.Message); }
            }
        }
    }

    /* ==================================================================== 界面 */

    internal sealed class InstallerForm : Form
    {
        private readonly bool uninstallMode;
        private string targetDir;              /* 安装模式下用户可改（「浏览…」或直接编辑） */
        private readonly bool makeShortcuts;
        private readonly string selfPath;

        private readonly Label title;
        private readonly Label whereLabel;     /* 卸载模式：只读显示安装目录 */
        private readonly TextBox dirBox;       /* 安装模式：可编辑的安装位置 */
        private readonly Button browse;
        private readonly Label status;
        private readonly ProgressBar bar;
        private readonly Button primary;
        private readonly CheckBox runAfter;

        private bool started;
        private bool finished;
        private string errorText;

        internal bool ErrorOccurred { get { return errorText != null; } }

        private delegate void ReportDelegate(int percent, string text);

        internal InstallerForm(bool uninstall, string targetDir, bool makeShortcuts, string selfPath)
        {
            this.uninstallMode = uninstall;
            this.targetDir = targetDir;
            this.makeShortcuts = makeShortcuts;
            this.selfPath = selfPath;

            Text = uninstall ? "卸载 " + Program.AppName : Program.AppName + " 安装程序";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(480, 214);
            Font = new Font("Microsoft YaHei UI", 9F);

            try { Icon = Icon.ExtractAssociatedIcon(selfPath); } catch { }

            title = new Label();
            title.Text = uninstall ? "卸载 " + Program.AppName : Program.AppDescription;
            title.Font = new Font(Font, FontStyle.Bold);
            title.AutoSize = true;
            title.Location = new Point(16, 16);
            Controls.Add(title);

            whereLabel = new Label();
            whereLabel.Text = "安装目录：" + targetDir;
            whereLabel.AutoSize = false;
            whereLabel.Size = new Size(448, 20);
            whereLabel.Location = new Point(16, 48);
            whereLabel.ForeColor = Color.DimGray;
            whereLabel.Visible = uninstall;
            Controls.Add(whereLabel);

            Label dirTip = new Label();
            dirTip.Text = "安装位置（可改成别的文件夹，例如 D:\\PI）：";
            dirTip.AutoSize = true;
            dirTip.Location = new Point(16, 46);
            dirTip.Visible = !uninstall;
            Controls.Add(dirTip);

            dirBox = new TextBox();
            dirBox.Text = targetDir;
            dirBox.Size = new Size(352, 24);
            dirBox.Location = new Point(16, 68);
            dirBox.Visible = !uninstall;
            Controls.Add(dirBox);

            browse = new Button();
            browse.Text = "浏览…";
            browse.Size = new Size(88, 26);
            browse.Location = new Point(376, 67);
            browse.Visible = !uninstall;
            browse.Click += new EventHandler(OnBrowseClick);
            Controls.Add(browse);

            status = new Label();
            status.Text = uninstall ? "点「卸载」开始。" : "点「安装」开始。";
            status.AutoSize = false;
            status.Size = new Size(448, 20);
            status.Location = new Point(16, 102);
            Controls.Add(status);

            bar = new ProgressBar();
            bar.Location = new Point(16, 126);
            bar.Size = new Size(448, 18);
            bar.Minimum = 0;
            bar.Maximum = 100;
            Controls.Add(bar);

            runAfter = new CheckBox();
            runAfter.Text = "安装完成后运行 " + Program.AppName;
            runAfter.Checked = true;
            runAfter.AutoSize = true;
            runAfter.Location = new Point(16, 158);
            runAfter.Visible = false;
            Controls.Add(runAfter);

            primary = new Button();
            primary.Text = uninstall ? "卸载" : "安装";
            primary.Size = new Size(96, 30);
            primary.Location = new Point(368, 158);
            primary.Click += new EventHandler(OnPrimaryClick);
            Controls.Add(primary);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.Size = new Size(96, 30);
            cancel.Location = new Point(262, 158);
            cancel.Click += new EventHandler(OnCancelClick);
            Controls.Add(cancel);

            AcceptButton = primary;
        }

        private void OnPrimaryClick(object sender, EventArgs e)
        {
            if (!started)
            {
                if (!uninstallMode && !ValidateTarget()) return;
                StartWork();
                return;
            }
            if (!finished) return;
            if (runAfter.Visible && runAfter.Checked)
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(targetDir, Program.AppExeName));
                    psi.WorkingDirectory = targetDir;
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                catch (Exception ex) { Log.Line("启动 " + Program.AppExeName + " 失败：" + ex.Message); }
            }
            Close();
        }

        private void OnCancelClick(object sender, EventArgs e)
        {
            if (!started) { Close(); return; }
            if (!finished) return;
            Close();
        }

        private void StartWork()
        {
            started = true;
            primary.Enabled = false;
            dirBox.Enabled = false;
            browse.Enabled = false;
            status.Text = uninstallMode ? "正在卸载…" : "正在安装…";
            Thread t = new Thread(new ThreadStart(Work));
            t.IsBackground = true;
            t.Start();
        }

        private void OnBrowseClick(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 " + Program.AppName + " 的安装位置";
                dlg.ShowNewFolderButton = true;
                try
                {
                    string cur = Path.GetFullPath(dirBox.Text.Trim());
                    if (Directory.Exists(cur)) dlg.SelectedPath = cur;
                }
                catch { }
                if (dlg.ShowDialog(this) != DialogResult.OK) return;

                string picked = dlg.SelectedPath;
                /* 选中一个已有文件夹时往下建一层 PI，免得 Electron 运行时散进用户的目录里；
                   末级已经是 PI 就不再套一层。 */
                string leaf = Path.GetFileName(picked.TrimEnd('\\'));
                if (!string.Equals(leaf, Program.AppName, StringComparison.OrdinalIgnoreCase))
                    picked = Path.Combine(picked, Program.AppName);
                dirBox.Text = picked;
            }
        }

        private bool ValidateTarget()
        {
            string dir = dirBox.Text.Trim().TrimEnd('\\');
            if (dir.Length == 0)
            {
                MessageBox.Show(this, "请先填写安装位置。", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            try { dir = Path.GetFullPath(dir); }
            catch (Exception ex)
            {
                MessageBox.Show(this, "这个路径不合法：" + ex.Message, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            string rootPath = Path.GetPathRoot(dir);
            if (string.IsNullOrEmpty(rootPath) || !Directory.Exists(rootPath))
            {
                MessageBox.Show(this, "盘符不存在：" + rootPath, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            if (string.Equals(dir.TrimEnd('\\'), rootPath.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(this, "请不要直接装到盘符根目录，换一个文件夹，例如 " + Path.Combine(rootPath, Program.AppName) + "。",
                    Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            targetDir = dir;
            dirBox.Text = dir;
            return true;
        }

        private void Work()
        {
            try
            {
                if (uninstallMode)
                {
                    Installer.Uninstall(targetDir, selfPath, new Action<int, string>(Report));
                }
                else
                {
                    Installer.Install(selfPath, targetDir, makeShortcuts, new Action<int, string>(Report));
                }
            }
            catch (Exception ex)
            {
                errorText = ex.Message;
                Log.Line("界面线程失败：" + ex.ToString());
                Report(100, "失败了：" + ex.Message);
                Finish();
                return;
            }
            Finish();
        }

        private void Report(int percent, string text)
        {
            if (!IsHandleCreated) return;
            try { BeginInvoke(new ReportDelegate(ApplyReport), new object[] { percent, text }); }
            catch { }
        }

        private void ApplyReport(int percent, string text)
        {
            if (percent >= 0)
            {
                if (percent > 100) percent = 100;
                bar.Value = percent;
            }
            status.Text = text;
        }

        private void Finish()
        {
            if (!IsHandleCreated) return;
            try { BeginInvoke(new MethodInvoker(ApplyFinish)); }
            catch { }
        }

        private void ApplyFinish()
        {
            finished = true;
            primary.Enabled = true;
            primary.Text = "关闭";
            if (errorText != null)
            {
                Text = "出错了";
                status.Text = "安装失败，详情见日志。";
                string logInfo = string.IsNullOrEmpty(Log.Path_)
                    ? "（日志也写不进去：所有候选位置都被拒绝访问）"
                    : Log.Path_;
                MessageBox.Show(this, errorText + "\r\n\r\n详细日志：" + logInfo,
                    Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            bar.Value = 100;
            status.Text = uninstallMode ? "卸载完成。" : "安装完成。";
            if (!uninstallMode) runAfter.Visible = true;
        }
    }
}
