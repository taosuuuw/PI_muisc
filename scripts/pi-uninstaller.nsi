/*
 * PI 卸载程序 —— NSIS 脚本
 * ============================================================================
 * 这是**独立的卸载器**，由 make-installer.mjs 用同一份 makensis 编译，然后被
 * pi-installer.nsi 用 `File /oname=卸载 PI.exe` 装进 $INSTDIR。
 *
 * 为什么不做成「安装器自带的卸载器」（WriteUninstaller）：
 *  1) 让安装路径少一样无法在本机验证的引擎行为 —— 本仓库的会话环境里 harness
 *     启动的建窗口进程会阻塞，安装器没法做运行级验收，所以安装路径上能省的引擎
 *     特性都要省（同一原因已经干掉了插件）；
 *  2) 卸载器不必再从自己的 exe 里生成一份自己，逻辑直白，还能单独替换。
 *
 * ★ 绝不使用 SetCompressor /SOLID ★
 * 整文件压缩会定义 NSIS_COMPRESS_WHOLE，运行时要求把整个数据块解压进 %TEMP% 的
 * 一个临时文件（NSIS 源码 Source/exehead/fileform.c 的 `#ifdef NSIS_COMPRESS_WHOLE`
 * 分支），建不出来就 return _LANG_ERRORWRITINGTEMP ⇒ 弹
 * 「NSIS Error: Error writing temporary file. Make sure your temp folder is valid.」。
 * 同理不用任何插件（插件要先解压到 $PLUGINSDIR = %TEMP%\nsuXXXX.tmp）。
 * 这个卸载器全程零临时文件：删目录交给系统 cmd 延时执行。
 *
 * 编译期参数（/D 必须写在脚本路径之前）：
 *   OUT_FILE / ICON_FILE / PRODUCT_NAME / APP_VERSION / APP_VERSION4 / PUBLISHER
 * ============================================================================
 */

Unicode true

!ifndef OUT_FILE
  !error "缺少 /DOUT_FILE=<输出 exe 路径>"
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

!define APP_EXE "pi.exe"
!define APP_REG_KEY "Software\${PRODUCT_NAME}"
!define UNINST_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

Name "${PRODUCT_NAME} 卸载程序"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
SetCompressor zlib
Icon "${ICON_FILE}"
ShowInstDetails nevershow

VIProductVersion "${APP_VERSION4}"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "PI 卸载程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "© 2026 PI"

BrandingText "${PRODUCT_NAME} 卸载程序"

/* 没有任何向导页：跑起来就是「确认 → 干活 → 退出」。
   MessageBox 是内置指令，不需要插件；静默模式（/S，即 QuietUninstallString）
   下 NSIS 会自动取默认按钮（这里默认「是」），不会卡住。 */
/* 注意：段名**不能**叫 "Uninstall" —— NSIS 把名叫 Uninstall 的段当成「卸载器专属
   段」，在普通安装器里会被整个丢弃，只剩这一个段的本脚本就会编译失败
   （实测报错：`Error: invalid script: no sections specified`）。 */
Section "PiUninstall"
  SetShellVarContext current

  /* 静默（/S，即 QuietUninstallString）时别问，直接干 —— 不依赖 NSIS 对静默
     MessageBox 的默认按钮推断，显式用 IfSilent 跳过去。IfSilent 是内置指令。 */
  IfSilent pi_uninst_go
  MessageBox MB_YESNO|MB_ICONQUESTION "确定要卸载 ${PRODUCT_NAME} 吗？$\r$\n$\r$\n程序目录会被删除；曲库缓存与设置（%APPDATA%\${PRODUCT_NAME}）会保留。" IDYES pi_uninst_go
  Abort
  pi_uninst_go:

  /* 应用还开着就删不掉文件，先关掉。用内置 ExecShell 调系统 taskkill（不用 nsExec 插件）。 */
  ExecShell "open" "$SYSDIR\taskkill.exe" "/IM ${APP_EXE} /F" SW_HIDE
  Sleep 1200

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  DeleteRegKey HKCU "${UNINST_REG_KEY}"
  DeleteRegKey HKCU "${APP_REG_KEY}"

  /* 卸载器自己就跑在 $EXEDIR 里，Windows 不允许运行中的 exe 删掉自己，所以把
     「等本进程退出后删掉整个目录」交给系统 cmd：
       ping -n 3 127.0.0.1   等约两秒（不产生任何文件）
       rmdir /s /q "<目录>"   连卸载器自己一起删掉
     全程不写任何临时文件（这也是不用 payload 里那个 uninstall-helper.ps1 的原因）。 */
  ExecShell "open" "$SYSDIR\cmd.exe" "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q $\"$EXEDIR$\"" SW_HIDE
SectionEnd
