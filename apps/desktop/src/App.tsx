import { AppShell, ThemeProvider, TransportProvider } from "@data-view/ui";
import { pickAndReadSqlFile, tauriTransport } from "./transport/tauri-transport";
import { ZoomController } from "./zoom/ZoomController";

export function App() {
  return (
    <ThemeProvider>
      <TransportProvider transport={tauriTransport}>
        <ZoomController />
        <AppShell
          enableCloseTabShortcut
          onPickSqlFile={pickAndReadSqlFile}
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
