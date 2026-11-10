# Release conventions

- The user wants every release of this WeChat assistant to update both the desktop startup shortcut and the desktop ZIP. Use one stable shortcut, `可可微信助手.lnk`, and one stable package, `可可微信助手_最新版.zip`, so old version names do not cause confusion.
- Keep the shortcut pointed at the canonical checkout's `start.ps1`, with the project's `assets/koko-app.ico`; do not point it at a temporary test directory or an older extracted release.
- The workspace helper `work/sync_koko_wechat_desktop.ps1` builds and validates a clean ZIP, backs up existing desktop artifacts, refreshes the shortcut, copies the latest package, and verifies the copied hash. Run it only after source edits and required tests are finished.
- Verify the actually running version through `/health` or authenticated `/api/state`. A version read from source or printed by a launcher is not proof that an existing process loaded the update.
- Preserve accounts, selected chats, model choice, personas, memory and send ledgers during upgrades. Never include `runtime.local.json`, state/data, database/key caches, logs, local environments or personal account information in distributable ZIPs.
- This convention does not authorize an otherwise prohibited production restart or live message test. Respect the current conversation's restart and real-message constraints; packaging and shortcut updates do not themselves restart the service.
- The separate B站 assistant is a different project. Do not replace its shortcut, folder or ZIP while releasing this WeChat assistant.
