; Дополнение к установщику (electron-builder, NSIS): шаг с галочкой «Ярлык на рабочем столе» после выбора папки.
; Свой ярлык electron-builder на рабочем столе не создаёт (createDesktopShortcut: false) — его создаём здесь, если галочка стоит.
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var DesktopCheckbox
  Var WantDesktop

  ; Функции шага — внутри макроса: этот файл подключается раньше Modern UI (MUI_HEADER_TEXT),
  ; а макрос раскрывается уже среди страниц установщика, когда Modern UI подключён.
  !macro customPageAfterChangeDir
    Page custom DesktopPageCreate DesktopPageLeave

    Function DesktopPageCreate
      !insertmacro MUI_HEADER_TEXT "Ярлыки" "Откуда запускать vaultboard"
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 24u "vaultboard появится в меню «Пуск». Можно добавить ярлык и на рабочий стол."
      Pop $0
      ${NSD_CreateCheckbox} 0 30u 100% 12u "Ярлык на рабочем столе"
      Pop $DesktopCheckbox
      ${NSD_Check} $DesktopCheckbox
      nsDialogs::Show
    FunctionEnd

    Function DesktopPageLeave
      ${NSD_GetState} $DesktopCheckbox $WantDesktop
    FunctionEnd
  !macroend
!endif

!macro customInstall
  ${If} $WantDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ; Тот же AppUserModelID, что у приложения: значок на панели задач не раздваивается.
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

!macro customUnInstall
  ; При обновлении старая версия удаляется молча перед установкой новой — ярлык пользователя оставляем.
  ${IfNot} ${isUpdated}
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${EndIf}
!macroend
