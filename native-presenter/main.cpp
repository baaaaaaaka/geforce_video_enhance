#include <windows.h>
#include <d3d11_4.h>
#include <dwmapi.h>
#include <dxgi1_6.h>
#include <inspectable.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowsapp.lib")

using namespace winrt;

namespace
{
struct RectState
{
    int x = 100;
    int y = 100;
    int width = 1280;
    int height = 720;
    int relativeX = -1;
    int relativeY = -1;
    int relativeWidth = -1;
    int relativeHeight = -1;
    bool visible = true;
};

struct EffectiveRect
{
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    int sourceLeft = 0;
    int sourceTop = 0;
    bool valid = false;
};

struct AppState
{
    std::mutex mutex;
    RectState rect;
    std::wstring pipeName;
    HWND hwnd = nullptr;
    HWND captureHwnd = nullptr;
    bool presentTimerActive = false;
    bool waitingForFreshFrame = true;
    POINT lastCursorPoint{ LONG_MIN, LONG_MIN };
    ULONGLONG cursorSuppressUntil = 0;
    bool cursorSuppressed = false;
    std::atomic<bool> running = true;
};

AppState g_state;

bool EffectiveOverlayVisible(const RectState& rect);
HWND CaptureHwnd();
bool GetWindowCaptureBounds(HWND hwnd, RECT& rect);
EffectiveRect ComputeEffectiveRect(const RectState& rect, const RECT& sourceRect);
bool CursorInsideRect(const EffectiveRect& rect);
bool CursorMovementSuppressesOverlay(const EffectiveRect& rect);
bool RectGeometryChanged(const RectState& previous, const RectState& next);
bool WaitingForFreshFrame();
void SetWaitingForFreshFrame(bool waiting);
void UpdatePresentTimer(HWND hwnd, bool active);

struct __declspec(uuid("f2cdd966-22ae-5ea1-9596-3a289344c3be")) IGraphicsCaptureSession3 : IInspectable
{
    virtual HRESULT STDMETHODCALLTYPE get_IsBorderRequired(boolean* value) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_IsBorderRequired(boolean value) = 0;
};

std::wstring GetArg(int argc, wchar_t** argv, const wchar_t* name, const wchar_t* fallback = L"")
{
    for (int i = 1; i < argc - 1; ++i)
    {
        if (_wcsicmp(argv[i], name) == 0)
        {
            return argv[i + 1];
        }
    }

    return fallback;
}

int GetIntArg(int argc, wchar_t** argv, const wchar_t* name, int fallback)
{
    std::wstring value = GetArg(argc, argv, name);
    if (value.empty())
    {
        return fallback;
    }

    return _wtoi(value.c_str());
}

bool GetBoolArg(int argc, wchar_t** argv, const wchar_t* name, bool fallback)
{
    std::wstring value = GetArg(argc, argv, name);
    if (value.empty())
    {
        return fallback;
    }

    return value == L"1" || _wcsicmp(value.c_str(), L"true") == 0;
}

HWND GetHwndArg(int argc, wchar_t** argv, const wchar_t* name)
{
    std::wstring value = GetArg(argc, argv, name);
    if (value.empty())
    {
        return nullptr;
    }

    return reinterpret_cast<HWND>(static_cast<uintptr_t>(wcstoull(value.c_str(), nullptr, 0)));
}

void ApplyClickThrough(HWND hwnd)
{
    LONG_PTR exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
    exStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
    exStyle &= ~WS_EX_TOPMOST;
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, exStyle);

    // Prevent the overlay from being captured by Windows Graphics Capture, so
    // the monitor capture sees the Chrome video below this window.
    SetWindowDisplayAffinity(hwnd, 0x00000011 /* WDA_EXCLUDEFROMCAPTURE */);
}

void MoveOverlayWindow(HWND hwnd, const RectState& rect)
{
    bool visible = EffectiveOverlayVisible(rect);
    RECT sourceRect{ rect.x, rect.y, rect.x + rect.width, rect.y + rect.height };
    HWND captureHwnd = CaptureHwnd();
    if (captureHwnd && IsWindow(captureHwnd))
    {
        GetWindowCaptureBounds(captureHwnd, sourceRect);
    }

    EffectiveRect effective = ComputeEffectiveRect(rect, sourceRect);
    visible = visible && effective.valid;
    bool cursorSuppressed = visible && CursorMovementSuppressesOverlay(effective);
    if (visible && (cursorSuppressed || WaitingForFreshFrame()))
    {
        visible = false;
    }

    SetWindowPos(
        hwnd,
        HWND_TOP,
        effective.valid ? effective.x : rect.x,
        effective.valid ? effective.y : rect.y,
        std::max(1, effective.valid ? effective.width : rect.width),
        std::max(1, effective.valid ? effective.height : rect.height),
        SWP_NOACTIVATE | SWP_NOOWNERZORDER | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    ShowWindow(hwnd, visible ? SW_SHOWNA : SW_HIDE);
    UpdatePresentTimer(hwnd, visible);
}

RectState CurrentRect()
{
    std::lock_guard<std::mutex> lock(g_state.mutex);
    return g_state.rect;
}

void UpdateRect(const RectState& rect)
{
    {
        std::lock_guard<std::mutex> lock(g_state.mutex);
        RectState previous = g_state.rect;
        g_state.rect = rect;
        if (!rect.visible || (!previous.visible && rect.visible) || RectGeometryChanged(previous, rect))
        {
            g_state.waitingForFreshFrame = true;
        }
    }

    if (g_state.hwnd)
    {
        MoveOverlayWindow(g_state.hwnd, rect);
    }
}

std::wstring PipePath()
{
    std::lock_guard<std::mutex> lock(g_state.mutex);
    return L"\\\\.\\pipe\\" + g_state.pipeName;
}

HWND CaptureHwnd()
{
    std::lock_guard<std::mutex> lock(g_state.mutex);
    return g_state.captureHwnd;
}

bool IsWindowCloaked(HWND hwnd)
{
    DWORD cloaked = 0;
    return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0;
}

bool CaptureWindowCanDisplay()
{
    HWND hwnd = CaptureHwnd();
    if (!hwnd)
    {
        return true;
    }

    return IsWindow(hwnd) &&
        IsWindowVisible(hwnd) &&
        !IsIconic(hwnd) &&
        !IsWindowCloaked(hwnd);
}

bool EffectiveOverlayVisible(const RectState& rect)
{
    return rect.visible && CaptureWindowCanDisplay();
}

bool GetWindowCaptureBounds(HWND hwnd, RECT& rect)
{
    if (!hwnd || !IsWindow(hwnd))
    {
        return false;
    }

    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect))))
    {
        return true;
    }

    return GetWindowRect(hwnd, &rect) != FALSE;
}

EffectiveRect ComputeEffectiveRect(const RectState& rect, const RECT& sourceRect)
{
    int sourceWidth = std::max(1, static_cast<int>(sourceRect.right - sourceRect.left));
    int sourceHeight = std::max(1, static_cast<int>(sourceRect.bottom - sourceRect.top));

    int left = rect.x - static_cast<int>(sourceRect.left);
    int top = rect.y - static_cast<int>(sourceRect.top);
    int width = rect.width;
    int height = rect.height;

    if (rect.relativeX >= 0 && rect.relativeY >= 0 && rect.relativeWidth > 0 && rect.relativeHeight > 0)
    {
        left = rect.relativeX;
        top = rect.relativeY;
        width = rect.relativeWidth;
        height = rect.relativeHeight;
    }

    int clippedLeft = std::clamp(left, 0, sourceWidth);
    int clippedTop = std::clamp(top, 0, sourceHeight);
    int clippedRight = std::clamp(left + std::max(1, width), 0, sourceWidth);
    int clippedBottom = std::clamp(top + std::max(1, height), 0, sourceHeight);

    EffectiveRect effective;
    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop)
    {
        return effective;
    }

    effective.x = static_cast<int>(sourceRect.left) + clippedLeft;
    effective.y = static_cast<int>(sourceRect.top) + clippedTop;
    effective.width = clippedRight - clippedLeft;
    effective.height = clippedBottom - clippedTop;
    effective.sourceLeft = clippedLeft;
    effective.sourceTop = clippedTop;
    effective.valid = true;
    return effective;
}

bool RectGeometryChanged(const RectState& previous, const RectState& next)
{
    return previous.x != next.x ||
        previous.y != next.y ||
        previous.width != next.width ||
        previous.height != next.height ||
        previous.relativeX != next.relativeX ||
        previous.relativeY != next.relativeY ||
        previous.relativeWidth != next.relativeWidth ||
        previous.relativeHeight != next.relativeHeight;
}

bool WaitingForFreshFrame()
{
    std::lock_guard<std::mutex> lock(g_state.mutex);
    return g_state.waitingForFreshFrame;
}

void SetWaitingForFreshFrame(bool waiting)
{
    std::lock_guard<std::mutex> lock(g_state.mutex);
    g_state.waitingForFreshFrame = waiting;
}

bool CursorInsideRect(const EffectiveRect& rect)
{
    if (!rect.valid)
    {
        return false;
    }

    POINT cursor{};
    if (!GetCursorPos(&cursor))
    {
        return false;
    }

    return cursor.x >= rect.x &&
        cursor.x < rect.x + rect.width &&
        cursor.y >= rect.y &&
        cursor.y < rect.y + rect.height;
}

bool CursorMovementSuppressesOverlay(const EffectiveRect& rect)
{
    if (!rect.valid)
    {
        return false;
    }

    POINT cursor{};
    if (!GetCursorPos(&cursor))
    {
        return false;
    }

    bool inside = cursor.x >= rect.x &&
        cursor.x < rect.x + rect.width &&
        cursor.y >= rect.y &&
        cursor.y < rect.y + rect.height;

    ULONGLONG now = GetTickCount64();
    std::lock_guard<std::mutex> lock(g_state.mutex);
    bool moved = cursor.x != g_state.lastCursorPoint.x || cursor.y != g_state.lastCursorPoint.y;
    g_state.lastCursorPoint = cursor;

    auto setSuppressed = [&](bool suppressed) {
        if (g_state.cursorSuppressed != suppressed)
        {
            g_state.waitingForFreshFrame = true;
        }
        g_state.cursorSuppressed = suppressed;
        return suppressed;
    };

    if (!inside)
    {
        g_state.cursorSuppressUntil = 0;
        return setSuppressed(false);
    }

    if (moved)
    {
        g_state.cursorSuppressUntil = now + 1600;
        return setSuppressed(true);
    }

    return setSuppressed(now < g_state.cursorSuppressUntil);
}

void TryDisableCaptureBorder(const winrt::Windows::Graphics::Capture::GraphicsCaptureSession& captureSession)
{
    winrt::com_ptr<IGraphicsCaptureSession3> session3;
    auto unknown = reinterpret_cast<IUnknown*>(winrt::get_abi(captureSession));
    if (unknown && SUCCEEDED(unknown->QueryInterface(__uuidof(IGraphicsCaptureSession3), session3.put_void())))
    {
        session3->put_IsBorderRequired(false);
    }
}

void HandlePipeCommand(const std::wstring& command)
{
    if (command.rfind(L"quit", 0) == 0)
    {
        g_state.running = false;
        if (g_state.hwnd)
        {
            PostMessage(g_state.hwnd, WM_CLOSE, 0, 0);
        }
        return;
    }

    RectState rect = CurrentRect();
    int visible = rect.visible ? 1 : 0;
    int relativeX = rect.relativeX;
    int relativeY = rect.relativeY;
    int relativeWidth = rect.relativeWidth;
    int relativeHeight = rect.relativeHeight;
    int matched = swscanf_s(
        command.c_str(),
        L"sync %d %d %d %d %d %d %d %d %d",
        &rect.x,
        &rect.y,
        &rect.width,
        &rect.height,
        &visible,
        &relativeX,
        &relativeY,
        &relativeWidth,
        &relativeHeight);

    if (matched == 5 || matched == 9)
    {
        rect.width = std::max(1, rect.width);
        rect.height = std::max(1, rect.height);
        rect.visible = visible != 0;
        if (matched == 9 && relativeX >= 0 && relativeY >= 0 && relativeWidth > 0 && relativeHeight > 0)
        {
            rect.relativeX = relativeX;
            rect.relativeY = relativeY;
            rect.relativeWidth = relativeWidth;
            rect.relativeHeight = relativeHeight;
        }
        UpdateRect(rect);
    }
}

void PipeServer()
{
    while (g_state.running)
    {
        std::wstring path = PipePath();
        HANDLE pipe = CreateNamedPipeW(
            path.c_str(),
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            nullptr);

        if (pipe == INVALID_HANDLE_VALUE)
        {
            Sleep(100);
            continue;
        }

        BOOL connected = ConnectNamedPipe(pipe, nullptr) ? TRUE : GetLastError() == ERROR_PIPE_CONNECTED;
        if (connected)
        {
            wchar_t buffer[256] = {};
            DWORD bytesRead = 0;
            if (ReadFile(pipe, buffer, sizeof(buffer) - sizeof(wchar_t), &bytesRead, nullptr) && bytesRead > 0)
            {
                buffer[std::min<DWORD>(bytesRead / sizeof(wchar_t), 255)] = 0;
                HandlePipeCommand(buffer);
            }
        }

        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
}

struct D3DResources
{
    std::mutex mutex;
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    com_ptr<IDXGISwapChain1> swapChain;
    com_ptr<ID3D11Texture2D> backBuffer;
    com_ptr<ID3D11Texture2D> latestFrame;
    int width = 0;
    int height = 0;
    bool hasLatestFrame = false;

    void Initialize(HWND hwnd, int initialWidth, int initialHeight)
    {
        width = std::max(1, initialWidth);
        height = std::max(1, initialHeight);

        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
        D3D_FEATURE_LEVEL createdLevel{};

        check_hresult(D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            levels,
            ARRAYSIZE(levels),
            D3D11_SDK_VERSION,
            device.put(),
            &createdLevel,
            context.put()));

        com_ptr<IDXGIDevice> dxgiDevice = device.as<IDXGIDevice>();
        com_ptr<IDXGIAdapter> adapter;
        check_hresult(dxgiDevice->GetAdapter(adapter.put()));

        com_ptr<IDXGIFactory2> factory;
        check_hresult(adapter->GetParent(__uuidof(IDXGIFactory2), factory.put_void()));

        DXGI_SWAP_CHAIN_DESC1 desc{};
        desc.Width = width;
        desc.Height = height;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        desc.BufferCount = 2;
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        desc.Scaling = DXGI_SCALING_STRETCH;
        desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;

        check_hresult(factory->CreateSwapChainForHwnd(device.get(), hwnd, &desc, nullptr, nullptr, swapChain.put()));
        check_hresult(factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER));
        RefreshBackBuffer();
        CreateLatestFrameTexture();
    }

    void RefreshBackBuffer()
    {
        backBuffer = nullptr;
        check_hresult(swapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), backBuffer.put_void()));
    }

    void CreateLatestFrameTexture()
    {
        latestFrame = nullptr;

        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = std::max(1, width);
        desc.Height = std::max(1, height);
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = 0;
        desc.MiscFlags = 0;

        check_hresult(device->CreateTexture2D(&desc, nullptr, latestFrame.put()));
        hasLatestFrame = false;
    }

    void Resize(int newWidth, int newHeight)
    {
        std::lock_guard<std::mutex> lock(mutex);
        newWidth = std::max(1, newWidth);
        newHeight = std::max(1, newHeight);
        if (newWidth == width && newHeight == height)
        {
            return;
        }

        backBuffer = nullptr;
        width = newWidth;
        height = newHeight;
        check_hresult(swapChain->ResizeBuffers(0, width, height, DXGI_FORMAT_UNKNOWN, 0));
        RefreshBackBuffer();
        CreateLatestFrameTexture();
    }

    void CopySourceToLatest(ID3D11Texture2D* sourceTexture, const D3D11_BOX& sourceBox)
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!latestFrame)
        {
            CreateLatestFrameTexture();
        }

        context->CopySubresourceRegion(
            latestFrame.get(),
            0,
            0,
            0,
            0,
            sourceTexture,
            0,
            &sourceBox);
        hasLatestFrame = true;
    }

    void PresentLatest()
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (!hasLatestFrame || !latestFrame || !backBuffer)
        {
            return;
        }

        context->CopyResource(backBuffer.get(), latestFrame.get());
        swapChain->Present(0, 0);
    }
};

struct CapturePresenter
{
    D3DResources d3d;
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool{ nullptr };
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session{ nullptr };
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{ nullptr };
    HMONITOR monitor = nullptr;
    HWND sourceWindow = nullptr;
    RECT sourceRect{};
    bool captureWindow = false;

    void Initialize(HWND hwnd, const RectState& rect)
    {
        d3d.Initialize(hwnd, rect.width, rect.height);
        RestartCapture(rect);
    }

    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice CreateWinRtDevice()
    {
        com_ptr<IDXGIDevice> dxgiDevice = d3d.device.as<IDXGIDevice>();
        com_ptr<::IInspectable> inspectable;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()));
        return inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
    }

    void RestartCapture(const RectState& rect)
    {
        framePool = nullptr;
        session = nullptr;
        item = nullptr;

        RECT winRect{ rect.x, rect.y, rect.x + rect.width, rect.y + rect.height };
        HWND requestedWindow = CaptureHwnd();
        if (requestedWindow && !IsWindow(requestedWindow))
        {
            captureWindow = false;
            sourceWindow = nullptr;
            sourceRect = winRect;
            return;
        }

        captureWindow = requestedWindow && IsWindow(requestedWindow);
        sourceWindow = captureWindow ? requestedWindow : nullptr;

        auto factory = get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        if (captureWindow && GetWindowCaptureBounds(sourceWindow, sourceRect))
        {
            check_hresult(factory->CreateForWindow(sourceWindow, guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(), put_abi(item)));
            monitor = MonitorFromWindow(sourceWindow, MONITOR_DEFAULTTONEAREST);
        }
        else
        {
            captureWindow = false;
            sourceWindow = nullptr;
            monitor = MonitorFromRect(&winRect, MONITOR_DEFAULTTONEAREST);

            MONITORINFO info{};
            info.cbSize = sizeof(info);
            GetMonitorInfoW(monitor, &info);
            sourceRect = info.rcMonitor;
            check_hresult(factory->CreateForMonitor(monitor, guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(), put_abi(item)));
        }

        auto winrtDevice = CreateWinRtDevice();
        framePool = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrtDevice,
            winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            item.Size());
        session = framePool.CreateCaptureSession(item);

        session.IsCursorCaptureEnabled(false);
        TryDisableCaptureBorder(session);

        framePool.FrameArrived({ this, &CapturePresenter::OnFrameArrived });
        session.StartCapture();
    }

    bool CaptureSourceChanged(const RectState& rect)
    {
        if (captureWindow)
        {
            return !sourceWindow || !IsWindow(sourceWindow);
        }

        RECT winRect{ rect.x, rect.y, rect.x + rect.width, rect.y + rect.height };
        HMONITOR nextMonitor = MonitorFromRect(&winRect, MONITOR_DEFAULTTONEAREST);
        return nextMonitor != monitor;
    }

    void OnFrameArrived(winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender, winrt::Windows::Foundation::IInspectable const&)
    {
        if (!g_state.running)
        {
            return;
        }

        auto frame = sender.TryGetNextFrame();
        RectState rect = CurrentRect();
        if (CaptureSourceChanged(rect))
        {
            RestartCapture(rect);
            return;
        }

        if (captureWindow)
        {
            GetWindowCaptureBounds(sourceWindow, sourceRect);
        }

        EffectiveRect effective = ComputeEffectiveRect(rect, sourceRect);
        if (!EffectiveOverlayVisible(rect) || !effective.valid)
        {
            return;
        }

        d3d.Resize(effective.width, effective.height);

        auto surface = frame.Surface();
        auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();

        com_ptr<ID3D11Texture2D> sourceTexture;
        check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), sourceTexture.put_void()));

        int left = effective.sourceLeft;
        int top = effective.sourceTop;
        int right = left + effective.width;
        int bottom = top + effective.height;

        auto size = frame.ContentSize();
        right = std::min(right, size.Width);
        bottom = std::min(bottom, size.Height);

        if (right <= left || bottom <= top)
        {
            return;
        }

        D3D11_BOX sourceBox{};
        sourceBox.left = static_cast<UINT>(left);
        sourceBox.top = static_cast<UINT>(top);
        sourceBox.front = 0;
        sourceBox.right = static_cast<UINT>(right);
        sourceBox.bottom = static_cast<UINT>(bottom);
        sourceBox.back = 1;

        bool wasWaitingForFreshFrame = WaitingForFreshFrame();
        d3d.CopySourceToLatest(sourceTexture.get(), sourceBox);
        if (wasWaitingForFreshFrame)
        {
            d3d.PresentLatest();
            SetWaitingForFreshFrame(false);
            if (g_state.hwnd)
            {
                MoveOverlayWindow(g_state.hwnd, rect);
                if (IsWindowVisible(g_state.hwnd))
                {
                    d3d.PresentLatest();
                    DwmFlush();
                }
            }
        }
    }

    void PresentLatest()
    {
        d3d.PresentLatest();
    }
};

CapturePresenter* g_presenter = nullptr;

void UpdatePresentTimer(HWND hwnd, bool active)
{
    bool shouldRun = active && g_presenter != nullptr;
    bool currentlyRunning = false;
    {
        std::lock_guard<std::mutex> lock(g_state.mutex);
        currentlyRunning = g_state.presentTimerActive;
        if (currentlyRunning == shouldRun)
        {
            return;
        }

        g_state.presentTimerActive = shouldRun;
    }

    if (shouldRun)
    {
        SetTimer(hwnd, 2, 8, nullptr);
    }
    else
    {
        KillTimer(hwnd, 2);
    }
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_NCHITTEST:
        return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
        return MA_NOACTIVATE;
    case WM_TIMER:
        if (wParam == 1)
        {
            MoveOverlayWindow(hwnd, CurrentRect());
            return 0;
        }
        if (wParam == 2)
        {
            RectState rect = CurrentRect();
            if (EffectiveOverlayVisible(rect) && g_presenter)
            {
                MoveOverlayWindow(hwnd, rect);
                g_presenter->PresentLatest();
            }
            return 0;
        }
        return 0;
    case WM_DESTROY:
        KillTimer(hwnd, 1);
        KillTimer(hwnd, 2);
        g_state.running = false;
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProc(hwnd, message, wParam, lParam);
    }
}
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
    init_apartment(apartment_type::multi_threaded);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    timeBeginPeriod(1);

    int argc = 0;
    wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    RectState initialRect;
    initialRect.x = GetIntArg(argc, argv, L"--x", initialRect.x);
    initialRect.y = GetIntArg(argc, argv, L"--y", initialRect.y);
    initialRect.width = GetIntArg(argc, argv, L"--width", initialRect.width);
    initialRect.height = GetIntArg(argc, argv, L"--height", initialRect.height);
    initialRect.visible = GetBoolArg(argc, argv, L"--visible", true);
    initialRect.relativeX = GetIntArg(argc, argv, L"--relative-x", initialRect.relativeX);
    initialRect.relativeY = GetIntArg(argc, argv, L"--relative-y", initialRect.relativeY);
    initialRect.relativeWidth = GetIntArg(argc, argv, L"--relative-width", initialRect.relativeWidth);
    initialRect.relativeHeight = GetIntArg(argc, argv, L"--relative-height", initialRect.relativeHeight);
    HWND captureHwnd = GetHwndArg(argc, argv, L"--capture-hwnd");
    std::wstring pipeName = GetArg(argc, argv, L"--pipe", L"");

    if (argv)
    {
        LocalFree(argv);
    }

    {
        std::lock_guard<std::mutex> lock(g_state.mutex);
        g_state.rect = initialRect;
        g_state.pipeName = pipeName;
        g_state.captureHwnd = captureHwnd;
    }

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WindowProc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.lpszClassName = L"RtxSmoothOverlayPresenterWindow";
    RegisterClassExW(&wc);

    HWND hwnd = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
        wc.lpszClassName,
        L"RTX Smooth Motion Presenter",
        WS_POPUP,
        initialRect.x,
        initialRect.y,
        initialRect.width,
        initialRect.height,
        captureHwnd,
        nullptr,
        instance,
        nullptr);

    g_state.hwnd = hwnd;
    ApplyClickThrough(hwnd);
    MoveOverlayWindow(hwnd, initialRect);
    SetTimer(hwnd, 1, 100, nullptr);

    std::thread pipeThread;
    if (!pipeName.empty())
    {
        pipeThread = std::thread(PipeServer);
    }

    CapturePresenter presenter;
    g_presenter = &presenter;

    try
    {
        presenter.Initialize(hwnd, initialRect);
        MoveOverlayWindow(hwnd, CurrentRect());
    }
    catch (...)
    {
        MessageBoxW(hwnd, L"Failed to initialize Windows Graphics Capture presenter.", L"RTX Smooth Motion Presenter", MB_ICONERROR);
        g_state.running = false;
    }

    MSG msg{};
    while (g_state.running && GetMessage(&msg, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    g_state.running = false;
    if (!pipeName.empty())
    {
        // Wake a blocking ConnectNamedPipe call so the pipe thread can exit.
        HANDLE pipe = CreateFileW(PipePath().c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (pipe != INVALID_HANDLE_VALUE)
        {
            CloseHandle(pipe);
        }
    }

    if (pipeThread.joinable())
    {
        pipeThread.join();
    }

    timeEndPeriod(1);
    return 0;
}
