; Iniciar com o sistema (src-tauri/src/autostart.rs): desinstalar apaga o início automático; atualizar (o Tauri
; desinstala a versão velha com /UPDATE) mantém a escolha
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Stivo"
  ${EndIf}
!macroend
