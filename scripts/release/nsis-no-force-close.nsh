; Replace electron-builder's force-close fallback. Never terminate other processes.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  ReadEnvStr $0 "DAEMONLET_OWNED_UPDATE_PID"
  ${If} $0 != ""
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r0) p.r1'
    ${If} $1 != 0
      System::Call 'kernel32::WaitForSingleObject(p r1, i 15000) i.r2'
      System::Call 'kernel32::CloseHandle(p r1)'
      ${If} $2 != 0
        DetailPrint "The requesting app has not exited. Close it and retry."
        SetErrorLevel 32
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  StrCpy $3 0
  ${Do}
    ; OPEN_EXISTING checks only the target image lock. It never writes the file.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r1 ?e'
    Pop $2
    ${If} $1 != -1
      System::Call 'kernel32::CloseHandle(p r1)'
      ${ExitDo}
    ${EndIf}
    ${If} $2 == 2
    ${OrIf} $2 == 3
      ${ExitDo}
    ${EndIf}
    IntOp $3 $3 + 1
    ${If} $3 >= 50
      DetailPrint "The installation is still in use or not writable. Close it and retry."
      SetErrorLevel 32
      Quit
    ${EndIf}
    Sleep 200
  ${Loop}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
