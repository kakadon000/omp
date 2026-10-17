; OMP NSIS installer hooks (tauri.conf.json → bundle.windows.nsis.installerHooks)
;
; Root cause fixed here: upgrading while OMP.exe is still running (or the AV
; momentarily holding a freshly written DLL) makes NSIS fail with
; "error writing to file resources\mpv-2.dll" — the engine never installs and
; the app silently falls back to the heavy WebView engine (CPU burn).
;
; Fix: force-close every OMP process BEFORE file extraction, then retry-delete
; the files that tend to stay locked.

!macro OMP_KILL_APP
  DetailPrint "Closing OMP if it is still running..."
  nsExec::Exec 'taskkill /IM "OMP.exe" /T /F'
  Pop $0
  ; WebView2 + mpv threads can take a moment to release their file handles
  Sleep 1200
  ; second pass for good measure (elevated instance may have respawned)
  nsExec::Exec 'taskkill /IM "OMP.exe" /T /F'
  Pop $0
  Sleep 400
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OMP_KILL_APP

  ; Retry-delete the big engine DLL - the one file that hard-locked installs.
  ; If it is still undeletable after 20 tries (~14s) NSIS overwrite will
  ; normally still succeed once the handle is gone.
  StrCpy $R9 0
  omp_retry_delete:
    ClearErrors
    Delete "$INSTDIR\resources\mpv-2.dll"
    IfErrors 0 omp_delete_done
    IntOp $R9 $R9 + 1
    IntCmp $R9 20 omp_delete_done 0 omp_delete_done
    Sleep 700
    Goto omp_retry_delete
  omp_delete_done:
    DetailPrint "OMP closed - installing the engine..."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "OMP installed. Enjoy - every format, one player."
!macroend
