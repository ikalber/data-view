import type { Metadata } from "next";
import { themeInitScript } from "@data-view/ui";
import "@data-view/ui/styles.css";

export const metadata: Metadata = {
  title: "Data View",
  description: "Visor de bases de datos multiplataforma",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script
          // Runs before React hydrates so [data-theme] is set when the first
          // paint happens — no flash of wrong theme.
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
