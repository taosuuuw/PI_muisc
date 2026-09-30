/* NSIS 探针 —— 用来判定「这台机器到底能不能跑 NSIS 安装器」以及卡在哪条路径上。
   编译三份：
     /DPROBE=plain   zlib、无插件        → 基线（我们的 v0.1.1 就是这条路）
     /DPROBE=solid   SetCompressor /SOLID → 强制走「把整块解压到 %TEMP% 临时文件」的路
     /DPROBE=plugin  调用 nsExec 插件      → 强制走「解压插件到 $PLUGINSDIR(%TEMP%\nsuXXXX.tmp)」的路
   三份都会：在 .onInit 里先写日志再弹框、段里写文件再删目录。 */
Unicode true
!ifndef PROBE
  !define PROBE "plain"
!endif
!ifndef OUT_FILE
  !error "缺 /DOUT_FILE"
!endif
!ifndef ICON_FILE
  !error "缺 /DICON_FILE"
!endif
Name "NSIS probe ${PROBE}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
Icon "${ICON_FILE}"

!if "${PROBE}" == "solid"
  SetCompressor /SOLID zlib
!else
  SetCompressor zlib
!endif

Function .onInit
  ClearErrors
  FileOpen $9 "$EXEDIR\NSIS-探针日志.txt" "a"
  IfErrors pi_init_done 0
    FileWrite $9 "probe=${PROBE} oninit temp=$TEMP execdir=$EXEDIR$\r$\n"
    FileClose $9
  pi_init_done:
  MessageBox MB_OK "NSIS 探针 [${PROBE}] 已启动。$\r$\n$\r$\nTEMP=$TEMP$\r$\n$\r$\n看到这个框 = NSIS 引擎本身能起来。"
FunctionEnd

Section "Probe"
  !if "${PROBE}" == "plugin"
    nsExec::ExecToStack 'cmd /c echo hello'
    Pop $0
    Pop $1
  !endif
  ClearErrors
  FileOpen $9 "$EXEDIR\NSIS-探针日志.txt" "a"
  IfErrors pi_sec_done 0
    FileWrite $9 "probe=${PROBE} section ok$\r$\n"
    FileClose $9
  pi_sec_done:
  SetOutPath "$EXEDIR\.probe-out"
  FileOpen $8 "$EXEDIR\.probe-out\marker.txt" "w"
  FileWrite $8 "marker$\r$\n"
  FileClose $8
  RMDir /r "$EXEDIR\.probe-out"
  MessageBox MB_OK "NSIS 探针 [${PROBE}] 跑完了：段执行、写文件、删目录都正常。"
SectionEnd
