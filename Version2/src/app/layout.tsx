import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tablero de partidos",
  description: "Consulta partidos y evidencia deportiva disponible.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}