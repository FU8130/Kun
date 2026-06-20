!macro customCheckAppRunning
  Var /GLOBAL KunInstallerCurrentPid
  Var /GLOBAL KunInstallerStopAttempt
  Var /GLOBAL KunInstallerStopResult

  ${if} $INSTDIR == ""
    Return
  ${endif}

  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $KunInstallerCurrentPid $0
  System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_APP_ROOT", "$INSTDIR").r0'
  System::Call 'kernel32::SetEnvironmentVariable(t, t)i ("KUN_INSTALLER_SELF_PID", "$KunInstallerCurrentPid").r0'

  StrCpy $KunInstallerStopAttempt 0

  KunStopProcessesFromInstallDir:
    IntOp $KunInstallerStopAttempt $KunInstallerStopAttempt + 1
    DetailPrint "Checking for running ${PRODUCT_NAME} processes under $INSTDIR."
    nsExec::Exec `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue'; $$root=[System.IO.Path]::GetFullPath($$env:KUN_INSTALLER_APP_ROOT).TrimEnd('\'); $$self=[int]$$env:KUN_INSTALLER_SELF_PID; $$procs=@(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ProcessId -ne $$self -and $$_.Path -and [System.IO.Path]::GetFullPath($$_.Path).StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$procs.Count -gt 0) { $$procs | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0 } else { exit 1 }"`
    Pop $KunInstallerStopResult

    ${if} $KunInstallerStopResult != 0
      Goto KunInstallDirProcessesStopped
    ${endif}

    Sleep 1200
    ${if} $KunInstallerStopAttempt <= 5
      Goto KunStopProcessesFromInstallDir
    ${endif}

    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY KunStopProcessesFromInstallDir
    Quit

  KunInstallDirProcessesStopped:
!macroend
