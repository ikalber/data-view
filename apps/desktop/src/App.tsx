import { AppShell, ThemeProvider, TransportProvider } from "@data-view/ui";
import { tauriTransport } from "./transport/tauri-transport";
import { ZoomController } from "./zoom/ZoomController";

export function App() {
  return (
    <ThemeProvider>
      <TransportProvider transport={tauriTransport}>
        <ZoomController />
        <AppShell
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
