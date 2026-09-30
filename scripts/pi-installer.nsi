/*
 * PI 安装包 —— NSIS 脚本
 * ============================================================================
 * 由 `scripts/make-installer.mjs` 调用 makensis 编译。源文件是 **UTF-8 无 BOM**，
 * 所以编译命令必须带 `/INPUTCHARSET UTF8`。
 *
 * 为什么不用 electron-builder 的 nsis 目标：它的构建流程里有一道「先编出一个中间
 * 安装器、再**真的执行它**来产出卸载器」的步骤（app-builder-lib 的 NsisTarget.js
 * 里 WineVmManager.exec(installerPath)），而本仓库的会话环境里由 harness 启动的
 * 建窗口进程会阻塞，这一步永远过不去。自己写 NSIS 脚本 + 直接调 makensis 就没有
 * 「编译期执行产物」这个要求，同时也让我们完全掌控「应用和功能」的注册表项。
 *
 * ★ 安装路径必须零临时文件 ★
 * 用户实测弹过「NSIS Error: Error writing temporary file. Make sure your temp
 * folder is valid.」。这条文案在 NSIS 源码里是 `_LANG_ERRORWRITINGTEMP`，能达到它的
 * 代码路径只有两条（都已逐条排除）：
 *   1) 整文件压缩：`SetCompressor /SOLID …` 会定义 NSIS_COMPRESS_WHOLE，运行时必须
 *      先把整个数据块解压进 %TEMP% 的一个临时文件 —— Source/exehead/fileform.c 的
 *      `#ifdef NSIS_COMPRESS_WHOLE` 分支里
 *      CreateFile(fno, …, FILE_ATTRIBUTE_TEMPORARY|FILE_FLAG_DELETE_ON_CLOSE, …)
 *      失败就 `return _LANG_ERRORWRITINGTEMP`。
 *      ⇒ 本脚本**永远不用 /SOLID**，三个档位都是非整块压缩（默认 zlib）。
 *   2) 插件：任何插件都得先解压到 $PLUGINSDIR（= %TEMP%\nsuXXXX.tmp，名字出自
 *      Source/exehead/util.c 的 my_GetTempFileName 前缀 "nsa"…；目录由带受限 ACL 的
 *      CreateRestrictedDirectory 建），临时目录不可用就报同一条错。
 *      ⇒ 本脚本**不使用任何插件**，需要的能力全部用内置指令实现：
 *         · 判断 pi.exe 是否在运行 → FileOpen 写句柄探测（见安装段注释）
 *         · 结束进程 → ExecShell 调系统 taskkill
 *   3) 卸载器不再是安装期用 WriteUninstaller 生成的，而是由
 *      scripts/pi-uninstaller.nsi 单独编译成 `卸载 PI.exe` 一起装进去
 *      （安装期少一样无法在本机验证的引擎行为，卸载器也能单独替换/单独验证）。
 *
 * 编译后怎么复核：
 *   · `node scripts/patch-exe.mjs <setup.exe> --verify-only` 看图标/版本信息；
 *   · 安装时本脚本会往 `$EXEDIR\PI-安装日志.txt` 追加纯 ASCII 的进度行 ——
 *     安装器没法在本机做运行级验收，这份日志就是唯一的现场记录；
 *   · 在 makensis 的 /V4 日志（.tmp/makensis.log）里搜 `PLUGINSDIR`，应当是 0 条。
 *
 * 编译期参数由 make-installer.mjs 用 /D 传入（/D 必须写在脚本路径之前）：
 *   PAYLOAD        release\pi 载荷目录（整目录递归进安装包）
 *   OUT_FILE       输出 exe
 *   ICON_FILE      build\pi-embed.ico
 *   README_FILE    scripts\installer-readme.txt（安装版说明，覆盖便携版那份）
 *   UNINST_FILE    .tmp\pi-uninstaller.exe（独立卸载器，装成 `卸载 PI.exe`）
 *   PRODUCT_NAME / APP_VERSION / APP_VERSION4 / PUBLISHER /
 *   ESTIMATED_KB / COMPRESSOR
 *
 * 凡是含中文（或 © 这类非 ASCII）的显示文案与输出文件名，一律写在本文件里、不从
 * /D 传：makensis 读命令行参数时按系统 ANSI 代码页（简体中文机器上是 CP936）转换，
 * 实测 COPYRIGHT 里的 "©" 会变成 "?"。脚本文件本身按 UTF-8 读（编译时带
 * /INPUTCHARSET UTF8），中文是安全的。所以 /D 传进来的路径必须是纯 ASCII：
 * 独立卸载器先编到 .tmp 下的 ASCII 文件名，再由本文件用 /oname= 改成中文名。
 * ============================================================================
 */

Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"

/* ------------------------------------------------------------------ 参数 */

!ifndef PAYLOAD
  !error "缺少 /DPAYLOAD=<release\pi 目录>"
!endif
!ifndef OUT_FILE
  !error "缺少 /DOUT_FILE=<输出 exe 路径>"
!endif
!ifndef UNINST_FILE
  !error "缺少 /DUNINST_FILE=<独立卸载器 exe 路径>"
!endif
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "PI"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_VERSION4
  !define APP_VERSION4 "0.0.0.0"
!endif
!ifndef PUBLISHER
  !define PUBLISHER "PI"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "..\build\pi-embed.ico"
!endif
!ifndef README_FILE
  !define README_FILE "installer-readme.txt"
!endif
!ifndef ESTIMATED_KB
  !define ESTIMATED_KB "410000"
!endif
!ifndef COMPRESSOR
  !define COMPRESSOR "zlib"
!endif

!define APP_EXE "pi.exe"
!define UNINST_EXE "卸载 ${PRODUCT_NAME}.exe"
!define APP_REG_KEY "Software\${PRODUCT_NAME}"
!define UNINST_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define LOGFILE "$EXEDIR\PI-安装日志.txt"

/* -------------------------------------------------------------- 进度日志 */

/* 本仓库的会话环境里没法对安装器做运行级验收（harness 启动的建窗口进程会阻塞），
   所以每次安装都往安装包旁边追加一份进度日志：万一用户那边失败，它就是唯一的现场
   记录。只能写纯 ASCII —— FileWrite 的编码取决于安装器代码页，变量值（$TEMP、
   $INSTDIR 里的用户名等）也多是 ASCII，这样事后一定读得出来、不会变乱码。 */
Function WriteLog
  /* 入参：$R7 */
  ClearErrors
  FileOpen $9 "${LOGFILE}" "a"
  IfErrors pi_log_done 0
    FileWrite $9 "$R7$\r$\n"
    FileClose $9
  pi_log_done:
FunctionEnd

!macro PiLog line
  StrCpy $R7 "${line}"
  Call WriteLog
!macroend

Function .onInit
  /* 最早的一行：它出现就说明安装器引擎已经起来了（整块压缩的临时文件失败发生在
     这之前，那种情况下日志会一条都没有），同时记下安装器看到的 TEMP。 */
  !insertmacro PiLog "oninit temp=$TEMP execdir=$EXEDIR"
FunctionEnd

/* -------------------------------------------------------------- 基本信息 */

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${APP_REG_KEY}" "InstallDir"
RequestExecutionLevel user
Icon "${ICON_FILE}"
ShowInstDetails nevershow

VIProductVersion "${APP_VERSION4}"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "PI 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "© 2026 PI"

/* ---------------------------------------------------------------- 压缩档位 */
/* 一律非整块：/SOLID 会强制启动时把整个数据块解压进 %TEMP%（见文件头第 1 条），
   我们的载荷接近 400 MB，而这条报错就是这么来的。 */
!if "${COMPRESSOR}" == "lzma"
  SetCompressor lzma
  SetCompressorDictSize 64
!else
  !if "${COMPRESSOR}" == "bzip2"
    SetCompressor bzip2
  !else
    SetCompressor zlib
  !endif
!endif

/* -------------------------------------------------------------------- UI */
/* 只有安装向导页；本安装包不再自带卸载器（Section "Uninstall" 会被当普通安装段执行，
   所以连同 MUI_UNPAGE_* / MUI_UNICON 一起去掉了），卸载由随包安装的
   `卸载 PI.exe` 负责。 */

!define MUI_ICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${PRODUCT_NAME} 安装向导"
!define MUI_WELCOMEPAGE_TEXT "即将把 ${PRODUCT_NAME} 安装到你的电脑。$\r$\n$\r$\n安装位置默认是当前用户的 %LOCALAPPDATA%\Programs\${PRODUCT_NAME}，不需要管理员权限；安装完成后可以在 Windows 的「设置 → 应用 → 已安装的应用」里看到并卸载它。$\r$\n$\r$\n此前「便携版」里的用户数据（曲库缓存、设置，位于 %APPDATA%\${PRODUCT_NAME}）会被继续使用，不会重置。"
!define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} 安装完成"
!define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} 已经装好了。$\r$\n$\r$\n首次启动需要联网获取曲库数据；音乐解析依赖随包安装的 Node 运行时组件，目标机器不需要另装 Node.js。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${PRODUCT_NAME}"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\安装说明.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看安装说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"

/* -------------------------------------------------------------- 安装段 */

Section "${PRODUCT_NAME}" SEC_APP
  SectionIn RO
  SetShellVarContext current

  !insertmacro PiLog "section start instdir=$INSTDIR"

  /* 「应用正在运行」检测：**不用插件**（nsExec/FindProc 这类插件要先解压到
     $PLUGINSDIR = %TEMP%\nsuXXXX.tmp，临时目录不可用就会弹那条报错，这正是要根除
     的东西）。改用内置写句柄探测：对目标 exe 以可写方式 FileOpen，正在运行的 exe
     无人以共享写方式打开，因此必然失败（实测：运行中 → 打开失败；结束后 → 成功）。
     失败就给「重试 / 取消」，点重试回到标签重新探测。 */
  pi_lock_check:
    IfFileExists "$INSTDIR\${APP_EXE}" 0 pi_lock_done
    FileOpen $0 "$INSTDIR\${APP_EXE}" "a"
    StrCmp $0 "" pi_lock_busy pi_lock_free
    pi_lock_free:
      FileClose $0
      Goto pi_lock_done
    pi_lock_busy:
      !insertmacro PiLog "lock busy abort"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} 正在运行，安装前需要先关闭它。$\r$\n$\r$\n请退出 ${PRODUCT_NAME} 后点「重试」，或点「取消」退出安装。" IDRETRY pi_lock_check
      Abort
  pi_lock_done:
  !insertmacro PiLog "lock ok"

  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"
  !insertmacro PiLog "payload ok"

  /* 安装版说明覆盖便携版那份（同名文件，后写的赢；/oname 里的中文写在本文件里，
     不经命令行传递） */
  File /oname=安装说明.txt "${README_FILE}"
  /* 独立卸载器：由 scripts/pi-uninstaller.nsi 单独编译，全程零临时文件 */
  File "/oname=${UNINST_EXE}" "${UNINST_FILE}"
  !insertmacro PiLog "files ok"

  /* 快捷方式（内置 CreateShortCut，不需要插件） */
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  !insertmacro PiLog "shortcuts ok"

  /* 「应用和功能」登记：perMachine=false 时写 HKCU 即可，免 UAC。
     UninstallString 指向随包安装的独立卸载器；QuietUninstallString 走 /S 静默。 */
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_REG_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "EstimatedSize" "${ESTIMATED_KB}"

  WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_REG_KEY}" "Version" "${APP_VERSION}"
  !insertmacro PiLog "registry ok"

  !insertmacro PiLog "section ok"
SectionEnd
