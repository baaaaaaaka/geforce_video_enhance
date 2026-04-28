cmake_minimum_required(VERSION 3.20)
project(SmoothOverlayPresenter LANGUAGES CXX)

add_executable(smooth-presenter WIN32 main.cpp)
target_compile_features(smooth-presenter PRIVATE cxx_std_17)
target_compile_definitions(smooth-presenter PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(smooth-presenter PRIVATE d3d11 dxgi windowsapp user32 gdi32 winmm shell32 dwmapi)
