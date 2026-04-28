using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace RtxVsrNativeHost
{
    internal static class Program
    {
        private const string HostVersion = "0.1.0";

        private static async Task<int> Main()
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();

            try
            {
                while (true)
                {
                    JsonElement? request = await ReadMessage(input);
                    if (request == null)
                    {
                        return 0;
                    }

                    object response;

                    try
                    {
                        response = HandleRequest(request.Value);
                    }
                    catch (Exception ex)
                    {
                        response = new
                        {
                            ok = false,
                            error = ex.Message,
                            hostVersion = HostVersion
                        };
                    }

                    await WriteMessage(output, response);
                }
            }
            finally
            {
                SmoothOverlayController.Shutdown();
            }
        }

        private static object HandleRequest(JsonElement request)
        {
            string type = GetString(request, "type") ?? "";

            if (type == "ping")
            {
                return new { ok = true, hostVersion = HostVersion };
            }

            if (type == "smoothOverlayStart")
            {
                OverlayState state = OverlayState.FromRequest(request);
                ValidateUrl(state.Url);
                HostConfig overlayConfig = HostConfig.Load();
                string presenterPath = ResolvePresenterPath(overlayConfig.PresenterPath, overlayConfig.ExtensionRoot);
                return SmoothOverlayController.Start(presenterPath, state, HostVersion);
            }

            if (type == "smoothOverlaySync")
            {
                OverlayState state = OverlayState.FromRequest(request);
                ValidateUrl(state.Url);
                return SmoothOverlayController.Sync(state, HostVersion);
            }

            if (type == "smoothOverlayStop")
            {
                string reason = GetString(request, "reason") ?? "stop";
                return SmoothOverlayController.Stop(reason, HostVersion);
            }

            if (type == "smoothOverlayStatus")
            {
                return SmoothOverlayController.Status(HostVersion);
            }

            if (type != "openMode")
            {
                return new { ok = false, error = "Unsupported request type.", hostVersion = HostVersion };
            }

            string mode = NormalizeMode(GetString(request, "mode") ?? "");
            string url = GetString(request, "url") ?? "";
            bool dryRun = GetBool(request, "dryRun");

            ValidateUrl(url);

            HostConfig config = HostConfig.Load();
            string chromePath = ResolveChromePath(config.ChromePath);
            string extensionRoot = ResolveExtensionRoot(config.ExtensionRoot);
            string profilesRoot = ResolveProfilesRoot(config.ProfilesRoot);
            string profileDir = Path.Combine(profilesRoot, mode == "vsr" ? "vsr-on" : "vsr-off");
            Directory.CreateDirectory(profileDir);

            List<string> args = new List<string>
            {
                "--no-first-run",
                "--no-default-browser-check",
                "--new-window",
                "--user-data-dir=" + profileDir,
                "--load-extension=" + extensionRoot
            };

            if (mode == "non_vsr")
            {
                args.Add("--disable_vp_super_resolution");
            }

            args.Add(url);

            int? processId = null;

            if (!dryRun)
            {
                ProcessStartInfo startInfo = new ProcessStartInfo(chromePath)
                {
                    UseShellExecute = false
                };

                foreach (string arg in args)
                {
                    startInfo.ArgumentList.Add(arg);
                }

                Process? startedProcess = Process.Start(startInfo);
                processId = startedProcess?.Id;
            }

            return new
            {
                ok = true,
                mode,
                dryRun,
                processId,
                chromePath,
                profileDir,
                extensionRoot,
                hostVersion = HostVersion
            };
        }

        private static async Task<JsonElement?> ReadMessage(Stream input)
        {
            byte[] lengthBuffer = new byte[4];
            int lengthBytes = await ReadExactly(input, lengthBuffer, 4);
            if (lengthBytes == 0)
            {
                return null;
            }

            if (lengthBytes != 4)
            {
                throw new InvalidDataException("Invalid native message length header.");
            }

            int length = BitConverter.ToInt32(lengthBuffer, 0);
            if (length <= 0 || length > 1024 * 1024)
            {
                throw new InvalidDataException("Invalid native message size.");
            }

            byte[] payload = new byte[length];
            int payloadBytes = await ReadExactly(input, payload, length);
            if (payloadBytes != length)
            {
                throw new InvalidDataException("Native message ended early.");
            }

            return JsonDocument.Parse(payload).RootElement.Clone();
        }

        private static async Task<int> ReadExactly(Stream stream, byte[] buffer, int length)
        {
            int offset = 0;

            while (offset < length)
            {
                int read = await stream.ReadAsync(buffer, offset, length - offset);
                if (read == 0)
                {
                    break;
                }

                offset += read;
            }

            return offset;
        }

        private static async Task WriteMessage(Stream output, object response)
        {
            byte[] payload = JsonSerializer.SerializeToUtf8Bytes(response);
            byte[] length = BitConverter.GetBytes(payload.Length);
            await output.WriteAsync(length, 0, length.Length);
            await output.WriteAsync(payload, 0, payload.Length);
            await output.FlushAsync();
        }

        private static string NormalizeMode(string mode)
        {
            if (mode == "vsr")
            {
                return mode;
            }

            if (mode == "non_vsr" || mode == "nonVsr" || mode == "off")
            {
                return "non_vsr";
            }

            throw new InvalidOperationException("Unsupported VSR mode.");
        }

        private static void ValidateUrl(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? parsed))
            {
                throw new InvalidOperationException("Invalid URL.");
            }

            if (parsed.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidOperationException("Only HTTPS YouTube URLs are allowed.");
            }

            string host = parsed.Host.ToLowerInvariant();
            if (host != "www.youtube.com" &&
                host != "youtube.com" &&
                host != "m.youtube.com" &&
                host != "youtu.be" &&
                host != "www.youtube-nocookie.com")
            {
                throw new InvalidOperationException("Only YouTube URLs are allowed.");
            }
        }

        private static string ResolveChromePath(string? configuredPath)
        {
            if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
            {
                return configuredPath;
            }

            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe")
            };

            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new FileNotFoundException("Chrome was not found. Set chromePath in native host config.json.");
        }

        private static string ResolvePresenterPath(string? configuredPath, string? extensionRoot)
        {
            if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
            {
                return configuredPath;
            }

            List<string> candidates = new List<string>
            {
                Path.Combine(AppContext.BaseDirectory, "smooth-presenter.exe")
            };

            if (!string.IsNullOrWhiteSpace(extensionRoot))
            {
                candidates.Add(Path.Combine(extensionRoot, "native-presenter", "build", "Release", "smooth-presenter.exe"));
                candidates.Add(Path.Combine(extensionRoot, "native-presenter", "build", "RelWithDebInfo", "smooth-presenter.exe"));
            }

            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new FileNotFoundException("Smooth presenter was not found. Run scripts/install-native-host.ps1.");
        }

        private static string ResolveExtensionRoot(string? extensionRoot)
        {
            if (!string.IsNullOrWhiteSpace(extensionRoot) && Directory.Exists(extensionRoot))
            {
                return extensionRoot;
            }

            throw new DirectoryNotFoundException("Extension root was not configured. Run scripts/install-native-host.ps1.");
        }

        private static string ResolveProfilesRoot(string? profilesRoot)
        {
            if (!string.IsNullOrWhiteSpace(profilesRoot))
            {
                return profilesRoot;
            }

            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "GeForceVideoEnhance",
                "ChromeProfiles");
        }

        private static string? GetString(JsonElement element, string propertyName)
        {
            if (element.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }

            return null;
        }

        private static bool GetBool(JsonElement element, string propertyName)
        {
            return element.TryGetProperty(propertyName, out JsonElement value) &&
                   value.ValueKind == JsonValueKind.True;
        }
    }

    internal sealed class OverlayState
    {
        public string Url { get; private set; } = "";
        public OverlayRect Rect { get; private set; } = new OverlayRect();
        public OverlayRect? WindowRect { get; private set; }
        public OverlayRect? RelativeRect { get; private set; }
        public double CurrentTime { get; private set; }
        public bool Paused { get; private set; }
        public double Volume { get; private set; } = 1;
        public bool Muted { get; private set; }
        public double PlaybackRate { get; private set; } = 1;
        public int SeekSerial { get; private set; }
        public bool Visible { get; private set; } = true;

        public static OverlayState FromRequest(JsonElement request)
        {
            JsonElement rect = GetObject(request, "rect");
            JsonElement windowRect = GetObject(request, "windowRect");
            JsonElement relativeRect = GetObject(request, "relativeRect");
            JsonElement playback = GetObject(request, "playback");

            return new OverlayState
            {
                Url = GetString(request, "url") ?? "",
                Rect = new OverlayRect
                {
                    X = GetInt(rect, "x", 0),
                    Y = GetInt(rect, "y", 0),
                    Width = Math.Max(1, GetInt(rect, "width", 1)),
                    Height = Math.Max(1, GetInt(rect, "height", 1))
                },
                WindowRect = ReadOptionalRect(windowRect),
                RelativeRect = ReadOptionalRect(relativeRect),
                CurrentTime = Math.Max(0, GetDouble(playback, "currentTime", 0)),
                Paused = GetBool(playback, "paused", false),
                Volume = Math.Min(Math.Max(GetDouble(playback, "volume", 1), 0), 1),
                Muted = GetBool(playback, "muted", false),
                PlaybackRate = Math.Min(Math.Max(GetDouble(playback, "playbackRate", 1), 0.25), 4),
                SeekSerial = GetInt(playback, "seekSerial", 0),
                Visible = GetBool(playback, "visible", true)
            };
        }

        private static OverlayRect? ReadOptionalRect(JsonElement rect)
        {
            if (rect.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            return new OverlayRect
            {
                X = GetInt(rect, "x", 0),
                Y = GetInt(rect, "y", 0),
                Width = Math.Max(1, GetInt(rect, "width", 1)),
                Height = Math.Max(1, GetInt(rect, "height", 1))
            };
        }

        private static JsonElement GetObject(JsonElement element, string propertyName)
        {
            if (element.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.Object)
            {
                return value;
            }

            return default;
        }

        private static string? GetString(JsonElement element, string propertyName)
        {
            if (element.ValueKind == JsonValueKind.Object &&
                element.TryGetProperty(propertyName, out JsonElement value) &&
                value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }

            return null;
        }

        private static int GetInt(JsonElement element, string propertyName, int defaultValue)
        {
            if (element.ValueKind == JsonValueKind.Object &&
                element.TryGetProperty(propertyName, out JsonElement value) &&
                value.TryGetInt32(out int result))
            {
                return result;
            }

            return defaultValue;
        }

        private static double GetDouble(JsonElement element, string propertyName, double defaultValue)
        {
            if (element.ValueKind == JsonValueKind.Object &&
                element.TryGetProperty(propertyName, out JsonElement value) &&
                value.TryGetDouble(out double result))
            {
                return result;
            }

            return defaultValue;
        }

        private static bool GetBool(JsonElement element, string propertyName, bool defaultValue)
        {
            if (element.ValueKind == JsonValueKind.Object &&
                element.TryGetProperty(propertyName, out JsonElement value))
            {
                if (value.ValueKind == JsonValueKind.True)
                {
                    return true;
                }

                if (value.ValueKind == JsonValueKind.False)
                {
                    return false;
                }
            }

            return defaultValue;
        }
    }

    internal sealed class OverlayRect
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; } = 1;
        public int Height { get; set; } = 1;
    }

    internal static class SmoothOverlayController
    {
        private static readonly object Gate = new object();
        private static Process? presenterProcess;
        private static string? pipeName;
        private static IntPtr windowHandle = IntPtr.Zero;
        private static IntPtr captureWindowHandle = IntPtr.Zero;

        public static object Start(string presenterPath, OverlayState state, string hostVersion)
        {
            lock (Gate)
            {
                IntPtr nextCaptureWindow = FindBrowserWindowForRect(state.Rect);
                bool restarted = presenterProcess != null && !presenterProcess.HasExited;
                if (restarted)
                {
                    StopPresenterProcess();
                }

                if (presenterProcess == null || presenterProcess.HasExited)
                {
                    LaunchPresenter(presenterPath, state, nextCaptureWindow);
                }

                windowHandle = WaitForPresenterWindow(presenterProcess, windowHandle, 15000);
                ApplyState(state);

                return new
                {
                    ok = true,
                    mode = "smooth_overlay",
                    processId = presenterProcess?.Id,
                    hasWindow = windowHandle != IntPtr.Zero,
                    hasCaptureWindow = captureWindowHandle != IntPtr.Zero,
                    visible = state.Visible,
                    restarted,
                    presenterPath,
                    hostVersion
                };
            }
        }

        public static object Sync(OverlayState state, string hostVersion)
        {
            lock (Gate)
            {
                if (presenterProcess == null || presenterProcess.HasExited)
                {
                    return new
                    {
                        ok = false,
                        error = "Smooth Motion overlay is not running.",
                        hostVersion
                    };
                }

                windowHandle = WaitForPresenterWindow(presenterProcess, windowHandle, 1000);
                ApplyState(state);

                return new
                {
                    ok = true,
                    mode = "smooth_overlay",
                    processId = presenterProcess.Id,
                    hasWindow = windowHandle != IntPtr.Zero,
                    hasCaptureWindow = captureWindowHandle != IntPtr.Zero,
                    visible = state.Visible,
                    hostVersion
                };
            }
        }

        public static object Stop(string reason, string hostVersion)
        {
            lock (Gate)
            {
                int? processId = presenterProcess?.HasExited == false ? presenterProcess.Id : null;

                StopPresenterProcess();

                return new
                {
                    ok = true,
                    mode = "smooth_overlay",
                    stopped = true,
                    reason,
                    processId,
                    hostVersion
                };
            }
        }

        public static object Status(string hostVersion)
        {
            lock (Gate)
            {
                bool running = presenterProcess != null && !presenterProcess.HasExited;
                if (running)
                {
                    windowHandle = WaitForPresenterWindow(presenterProcess, windowHandle, 1000);
                }

                return new
                {
                    ok = true,
                    mode = "smooth_overlay",
                    running,
                    processId = running ? presenterProcess?.Id : null,
                    hasWindow = windowHandle != IntPtr.Zero,
                    hasCaptureWindow = captureWindowHandle != IntPtr.Zero,
                    hostVersion
                };
            }
        }

        public static void Shutdown()
        {
            lock (Gate)
            {
                StopPresenterProcess();
            }
        }

        private static void LaunchPresenter(string presenterPath, OverlayState state, IntPtr nextCaptureWindow)
        {
            pipeName = "rtx-vsr-presenter-" + Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N");
            captureWindowHandle = nextCaptureWindow;

            ProcessStartInfo startInfo = new ProcessStartInfo(presenterPath)
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };

            string[] args =
            {
                "--pipe", pipeName,
                "--x", state.Rect.X.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--y", state.Rect.Y.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--width", state.Rect.Width.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--height", state.Rect.Height.ToString(System.Globalization.CultureInfo.InvariantCulture),
                "--visible", state.Visible ? "1" : "0"
            };

            foreach (string arg in args)
            {
                startInfo.ArgumentList.Add(arg);
            }

            if (captureWindowHandle != IntPtr.Zero)
            {
                startInfo.ArgumentList.Add("--capture-hwnd");
                startInfo.ArgumentList.Add("0x" + captureWindowHandle.ToInt64().ToString("x", System.Globalization.CultureInfo.InvariantCulture));
            }

            if (state.RelativeRect != null)
            {
                startInfo.ArgumentList.Add("--relative-x");
                startInfo.ArgumentList.Add(state.RelativeRect.X.ToString(System.Globalization.CultureInfo.InvariantCulture));
                startInfo.ArgumentList.Add("--relative-y");
                startInfo.ArgumentList.Add(state.RelativeRect.Y.ToString(System.Globalization.CultureInfo.InvariantCulture));
                startInfo.ArgumentList.Add("--relative-width");
                startInfo.ArgumentList.Add(state.RelativeRect.Width.ToString(System.Globalization.CultureInfo.InvariantCulture));
                startInfo.ArgumentList.Add("--relative-height");
                startInfo.ArgumentList.Add(state.RelativeRect.Height.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            presenterProcess = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start smooth presenter.");
            Thread.Sleep(250);
        }

        private static void StopPresenterProcess()
        {
            if (presenterProcess != null && !presenterProcess.HasExited)
            {
                TrySendPresenterCommand("quit");
                if (!presenterProcess.WaitForExit(1200))
                {
                    presenterProcess.Kill(true);
                }
            }

            presenterProcess = null;
            pipeName = null;
            windowHandle = IntPtr.Zero;
            captureWindowHandle = IntPtr.Zero;
        }

        private static void ApplyState(OverlayState state)
        {
            string command = string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "sync {0} {1} {2} {3} {4} {5} {6} {7} {8}",
                state.Rect.X,
                state.Rect.Y,
                state.Rect.Width,
                state.Rect.Height,
                state.Visible ? 1 : 0,
                state.RelativeRect?.X ?? -1,
                state.RelativeRect?.Y ?? -1,
                state.RelativeRect?.Width ?? -1,
                state.RelativeRect?.Height ?? -1);
            TrySendPresenterCommand(command);
        }

        private static void TrySendPresenterCommand(string command)
        {
            if (string.IsNullOrWhiteSpace(pipeName))
            {
                return;
            }

            try
            {
                using NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
                pipe.Connect(250);
                using StreamWriter writer = new StreamWriter(pipe, Encoding.Unicode)
                {
                    AutoFlush = true
                };

                writer.Write(command);
            }
            catch
            {
                // The presenter may still be opening or closing; the next sync will retry.
            }
        }

        private static IntPtr WaitForPresenterWindow(Process? process, IntPtr existingHandle, int timeoutMs)
        {
            if (existingHandle != IntPtr.Zero && NativeMethods.IsWindow(existingHandle))
            {
                return existingHandle;
            }

            if (process == null || process.HasExited)
            {
                return IntPtr.Zero;
            }

            Stopwatch stopwatch = Stopwatch.StartNew();
            IntPtr found = IntPtr.Zero;

            while (stopwatch.ElapsedMilliseconds < timeoutMs && found == IntPtr.Zero)
            {
                found = FindWindowForProcess(process.Id);
                if (found == IntPtr.Zero)
                {
                    Thread.Sleep(50);
                }
            }

            return found;
        }

        private static IntPtr FindWindowForProcess(int processId)
        {
            IntPtr found = IntPtr.Zero;

            NativeMethods.EnumWindows((hWnd, lParam) =>
            {
                NativeMethods.GetWindowThreadProcessId(hWnd, out int windowProcessId);
                if (windowProcessId == processId)
                {
                    found = hWnd;
                    return false;
                }

                return true;
            }, IntPtr.Zero);

            return found;
        }

        private static IntPtr FindBrowserWindowForRect(OverlayRect target)
        {
            int centerX = target.X + target.Width / 2;
            int centerY = target.Y + target.Height / 2;
            IntPtr best = IntPtr.Zero;
            long bestArea = long.MaxValue;

            NativeMethods.EnumWindows((hWnd, lParam) =>
            {
                if (!NativeMethods.IsWindowVisible(hWnd))
                {
                    return true;
                }

                NativeMethods.GetWindowThreadProcessId(hWnd, out int processId);
                if (!IsBrowserProcess(processId))
                {
                    return true;
                }

                if (!NativeMethods.GetWindowRect(hWnd, out NativeMethods.RECT rect))
                {
                    return true;
                }

                if (centerX < rect.Left || centerX >= rect.Right || centerY < rect.Top || centerY >= rect.Bottom)
                {
                    return true;
                }

                long width = Math.Max(1, rect.Right - rect.Left);
                long height = Math.Max(1, rect.Bottom - rect.Top);
                long area = width * height;
                if (area < bestArea)
                {
                    bestArea = area;
                    best = hWnd;
                }

                return true;
            }, IntPtr.Zero);

            return best;
        }

        private static bool IsBrowserProcess(int processId)
        {
            try
            {
                string processName = Process.GetProcessById(processId).ProcessName;
                return processName.Equals("chrome", StringComparison.OrdinalIgnoreCase) ||
                       processName.Equals("msedge", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

    }

    internal static class NativeMethods
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }
    }

    internal sealed class HostConfig
    {
        public string? ChromePath { get; set; }
        public string? ExtensionRoot { get; set; }
        public string? ProfilesRoot { get; set; }
        public string? PresenterPath { get; set; }

        public static HostConfig Load()
        {
            string configPath = Path.Combine(AppContext.BaseDirectory, "config.json");
            if (!File.Exists(configPath))
            {
                return new HostConfig();
            }

            string json = File.ReadAllText(configPath, Encoding.UTF8);
            return JsonSerializer.Deserialize<HostConfig>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            }) ?? new HostConfig();
        }
    }
}
