using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;
using static Vortice.DXGI.DXGI;

namespace SmoothPresenter
{

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        int fps = GetIntArg(args, "--fps", 30);
        int width = GetIntArg(args, "--width", 1280);
        int height = GetIntArg(args, "--height", 720);
        int syncInterval = GetIntArg(args, "--sync-interval", 0);

        NativeMethods.TimeBeginPeriod(1);
        try
        {
            using var form = new PresenterForm(width, height, fps, syncInterval);
            Application.Run(form);
        }
        finally
        {
            NativeMethods.TimeEndPeriod(1);
        }
    }

    private static int GetIntArg(string[] args, string name, int fallback)
    {
        for (int i = 0; i < args.Length - 1; i += 1)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase) &&
                int.TryParse(args[i + 1], out int value))
            {
                return value;
            }
        }

        return fallback;
    }
}

internal sealed class PresenterForm : Form
{
    private readonly int targetFps;
    private readonly int syncInterval;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private D3D11Presenter? presenter;
    private readonly object presenterLock = new();
    private Thread? renderThread;
    private volatile bool running;
    private long frameIndex;

    public PresenterForm(int width, int height, int fps, int syncInterval)
    {
        targetFps = Math.Max(1, Math.Min(240, fps));
        this.syncInterval = Math.Max(0, Math.Min(4, syncInterval));
        Text = $"Smooth Presenter PoC - {targetFps}fps sync {this.syncInterval}";
        ClientSize = new Size(width, height);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        TopMost = true;
        BackColor = Color.Black;

    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        presenter = new D3D11Presenter(Handle, ClientSize.Width, ClientSize.Height, syncInterval);
        running = true;
        renderThread = new Thread(RenderLoop)
        {
            IsBackground = true,
            Name = "SmoothPresenterRenderLoop"
        };
        renderThread.Start();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (ClientSize.Width > 0 && ClientSize.Height > 0)
        {
            lock (presenterLock)
            {
                presenter?.Resize(ClientSize.Width, ClientSize.Height);
            }
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        running = false;
        renderThread?.Join(1000);
        lock (presenterLock)
        {
            presenter?.Dispose();
        }
        base.OnFormClosed(e);
    }

    private void RenderLoop()
    {
        double intervalSeconds = 1.0 / targetFps;
        double nextRenderSeconds = clock.Elapsed.TotalSeconds;

        while (running)
        {
            double now = clock.Elapsed.TotalSeconds;
            if (now < nextRenderSeconds)
            {
                int sleepMs = Math.Max(1, (int)((nextRenderSeconds - now) * 1000.0));
                Thread.Sleep(sleepMs);
                continue;
            }

            lock (presenterLock)
            {
                presenter?.Render(frameIndex, targetFps);
            }

            frameIndex += 1;
            nextRenderSeconds += intervalSeconds;
            if (clock.Elapsed.TotalSeconds - nextRenderSeconds > 0.25)
            {
                nextRenderSeconds = clock.Elapsed.TotalSeconds + intervalSeconds;
            }
        }
    }
}

internal sealed class D3D11Presenter : IDisposable
{
    private readonly ID3D11Device device;
    private readonly ID3D11DeviceContext context;
    private readonly IDXGISwapChain1 swapChain;
    private readonly int syncInterval;
    private ID3D11Texture2D? backBuffer;
    private uint[] background;
    private uint[] pixels;
    private GCHandle pixelHandle;
    private int width;
    private int height;
    private bool disposed;

    public D3D11Presenter(IntPtr hwnd, int initialWidth, int initialHeight, int syncInterval)
    {
        this.syncInterval = syncInterval;
        width = Math.Max(16, initialWidth);
        height = Math.Max(16, initialHeight);
        background = BuildBackground(width, height);
        pixels = new uint[width * height];
        pixelHandle = GCHandle.Alloc(pixels, GCHandleType.Pinned);

        FeatureLevel[] levels =
        {
            FeatureLevel.Level_11_1,
            FeatureLevel.Level_11_0
        };

        D3D11CreateDevice(
            null,
            DriverType.Hardware,
            DeviceCreationFlags.BgraSupport,
            levels,
            out device,
            out context).CheckError();

        using IDXGIDevice dxgiDevice = device.QueryInterface<IDXGIDevice>();
        using IDXGIAdapter adapter = dxgiDevice.GetAdapter();
        using IDXGIFactory2 factory = adapter.GetParent<IDXGIFactory2>();

        var description = new SwapChainDescription1
        {
            Width = width,
            Height = height,
            Format = Format.B8G8R8A8_UNorm,
            Stereo = false,
            SampleDescription = new SampleDescription(1, 0),
            BufferUsage = Usage.RenderTargetOutput,
            BufferCount = 2,
            Scaling = Scaling.Stretch,
            SwapEffect = SwapEffect.FlipDiscard,
            AlphaMode = AlphaMode.Ignore
        };

        swapChain = factory.CreateSwapChainForHwnd(device, hwnd, description);
        factory.MakeWindowAssociation(hwnd, WindowAssociationFlags.IgnoreAltEnter);
        backBuffer = swapChain.GetBuffer<ID3D11Texture2D>(0);
    }

    public void Resize(int newWidth, int newHeight)
    {
        if (disposed)
        {
            return;
        }

        newWidth = Math.Max(16, newWidth);
        newHeight = Math.Max(16, newHeight);
        if (newWidth == width && newHeight == height)
        {
            return;
        }

        backBuffer?.Dispose();
        backBuffer = null;

        width = newWidth;
        height = newHeight;
        background = BuildBackground(width, height);
        pixels = new uint[width * height];
        if (pixelHandle.IsAllocated)
        {
            pixelHandle.Free();
        }
        pixelHandle = GCHandle.Alloc(pixels, GCHandleType.Pinned);
        swapChain.ResizeBuffers(0, width, height, Format.Unknown, SwapChainFlags.None).CheckError();
        backBuffer = swapChain.GetBuffer<ID3D11Texture2D>(0);
    }

    public void Render(long frameIndex, int fps)
    {
        if (backBuffer == null || disposed)
        {
            return;
        }

        FillFrame(frameIndex, fps);
        context.UpdateSubresource(backBuffer, 0, null, pixelHandle.AddrOfPinnedObject(), width * 4, 0);

        swapChain.Present(syncInterval, PresentFlags.None);
    }

    private static uint[] BuildBackground(int width, int height)
    {
        var data = new uint[width * height];

        for (int y = 0; y < height; y += 1)
        {
            bool horizontalGrid = y % 64 == 0;
            byte g = (byte)(28 + (y * 96 / Math.Max(1, height)));
            int row = y * width;

            for (int x = 0; x < width; x += 1)
            {
                if (horizontalGrid || x % 64 == 0)
                {
                    data[row + x] = Bgra(95, 95, 95);
                    continue;
                }

                byte b = (byte)(24 + (x * 64 / Math.Max(1, width)));
                data[row + x] = Bgra(b, g, 36);
            }
        }

        return data;
    }

    private void FillFrame(long frameIndex, int fps)
    {
        Array.Copy(background, pixels, background.Length);

        int barWidth = Math.Max(24, width / 12);
        int barX = (int)((frameIndex * Math.Max(2, width / Math.Max(1, fps * 2))) % (width + barWidth)) - barWidth;
        int frameByte = (int)(frameIndex & 0xff);
        int left = Math.Max(0, barX);
        int right = Math.Min(width, barX + barWidth);

        if (left < right)
        {
            for (int y = 0; y < height; y += 1)
            {
                uint color = ((y / 32 + frameIndex) & 1) == 0
                    ? Bgra(40, 210, 255)
                    : Bgra(10, 160, 220);
                int row = y * width;
                for (int x = left; x < right; x += 1)
                {
                    pixels[row + x] = color;
                }
            }
        }

        uint topBand = Bgra((byte)frameByte, 120, 255);
        int bandHeight = Math.Min(28, height);
        for (int y = 0; y < bandHeight; y += 1)
        {
            int row = y * width;
            for (int x = 0; x < width; x += 1)
            {
                pixels[row + x] = topBand;
            }
        }
    }

    private static uint Bgra(byte b, byte g, byte r)
    {
        return 0xff000000u | ((uint)r << 16) | ((uint)g << 8) | b;
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        if (pixelHandle.IsAllocated)
        {
            pixelHandle.Free();
        }
        backBuffer?.Dispose();
        swapChain.Dispose();
        context.Dispose();
        device.Dispose();
    }
}

internal static class NativeMethods
{
    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
    public static extern uint TimeBeginPeriod(uint period);

    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod")]
    public static extern uint TimeEndPeriod(uint period);
}
}
