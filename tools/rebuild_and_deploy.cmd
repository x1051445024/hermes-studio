@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ========================================
echo Hermes Studio 构建和部署脚本
echo ========================================
echo.
echo 请确认：
echo 1. Hermes Studio 已经完全关闭
echo 2. 没有其他程序占用 src-0.7.18\dist 目录
echo.
echo 按任意键继续...
pause >nul

rem --- 路径占位符：使用前按本机实际路径修改（或先设置同名环境变量）---
if not defined SRC_DIR     set "SRC_DIR=<源码副本目录>\src-0.7.18"
if not defined TOOLS_DIR   set "TOOLS_DIR=<工具目录>"
if not defined NODE_EXE    set "NODE_EXE=<node.exe 路径>"
if not defined PYTHON_EXE  set "PYTHON_EXE=<python.exe 路径>"

echo.
echo 正在检查关键文件...

if not exist "%SRC_DIR%\node_modules\.bin\vite.cmd" (
    echo [错误] 找不到 vite.cmd
    echo 路径：%SRC_DIR%\node_modules\.bin\vite.cmd
    echo.
    pause
    exit /b 1
)
echo [✓] vite.cmd 存在

if not exist "%NODE_EXE%" (
    echo [错误] 找不到 node.exe
    echo 路径：%NODE_EXE%
    echo.
    pause
    exit /b 1
)
echo [✓] node.exe 存在

if not exist "%PYTHON_EXE%" (
    echo [错误] 找不到 python.exe
    echo 路径：%PYTHON_EXE%
    echo.
    pause
    exit /b 1
)
echo [✓] python.exe 存在

if not exist "%SRC_DIR%\scripts\build-server.mjs" (
    echo [错误] 找不到 build-server.mjs
    echo 路径：%SRC_DIR%\scripts\build-server.mjs
    echo.
    pause
    exit /b 1
)
echo [✓] build-server.mjs 存在

if not exist "%TOOLS_DIR%\tools\deploy_0718_extra_headers.py" (
    echo [错误] 找不到部署脚本
    echo 路径：%TOOLS_DIR%\tools\deploy_0718_extra_headers.py
    echo.
    pause
    exit /b 1
)
echo [✓] deploy_0718_extra_headers.py 存在

echo.
echo 所有关键文件检查通过！
echo.
echo 即将开始构建（请确认 Hermes Studio 已完全关闭）...
timeout /t 3 /nobreak >nul

echo [1/3] 构建客户端...
cd /d "%SRC_DIR%"
call "%SRC_DIR%\node_modules\.bin\vite.cmd" build
if !errorlevel! neq 0 (
    echo.
    echo [失败] 客户端构建失败！错误码: !errorlevel!
    echo.
    pause
    exit /b 1
)
echo [✓] 客户端构建成功

echo.
echo [2/3] 构建服务端...
cd /d "%SRC_DIR%"
"%NODE_EXE%" "%SRC_DIR%\scripts\build-server.mjs"
if !errorlevel! neq 0 (
    echo.
    echo [失败] 服务端构建失败！错误码: !errorlevel!
    echo.
    pause
    exit /b 1
)
echo [✓] 服务端构建成功

echo.
echo [3/3] 部署到 Hermes Studio...
cd /d "%TOOLS_DIR%"
"%PYTHON_EXE%" "%TOOLS_DIR%\tools\deploy_0718_extra_headers.py"
if !errorlevel! neq 0 (
    echo.
    echo [失败] 部署失败！错误码: !errorlevel!
    echo.
    pause
    exit /b 1
)
echo [✓] 部署成功

echo.
echo ========================================
echo 构建和部署完成！
echo.
echo 现在可以重新启动 Hermes Studio。
echo 启动后测试"自用帅API"，上游应该会看到:
echo   originator: codex_cli_rs
echo   user-agent: codex_cli_rs/0.153.4 (...)
echo 而不是:
echo   originator: codex_exec
echo ========================================
echo.
pause
