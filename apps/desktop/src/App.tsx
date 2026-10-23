import { AppShell, ThemeProvider, TransportProvider } from "@data-view/ui";
import {
  pickAndReadSqlFile,
  subscribeFileDrop,
  tauriTransport,
} from "./transport/tauri-transport";
import { ZoomController } from "./zoom/ZoomController";
// Vite inlines just this field; kept in sync with tauri.conf.json by the
// release script.
import { version as appVersion } from "../package.json";

export function App() {
  return (
    <ThemeProvider>
      <TransportProvider transport={tauriTransport}>
        <ZoomController />
        <AppShell
          enableCloseTabShortcut
          onPickSqlFile={pickAndReadSqlFile}
          subscribeFileDrop={subscribeFileDrop}
          appVersion={appVersion}
          userArea={
            <span
              style={{
                fontSize: 11,
                color: "var(--dv-text-mute)",
                fontFamily: "var(--dv-mono)",
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              desktop
            </span>
          }
        />
      </TransportProvider>
    </ThemeProvider>
  );
}
