import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Sans, Spline_Sans_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Rail } from "@/components/rail";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});
const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});
const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
});

export const metadata: Metadata = {
  title: "Scuttledeck",
  description: "Fleet monitoring for the Claude Code GitHub Action",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const theme = jar.get("sd_theme")?.value === "dark" ? "dark" : "light";
  const collapsed = jar.get("sd_rail")?.value === "collapsed";

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${bricolage.variable} ${instrument.variable} ${splineMono.variable}`}
    >
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <Rail
            initialCollapsed={collapsed}
            initialTheme={theme}
            authEnabled={Boolean(process.env.DASHBOARD_PASSWORD)}
          />
          <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
