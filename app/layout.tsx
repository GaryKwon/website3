import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EV:ON — 차량별 전기차 보조금",
  description: "지역과 차량, 세부 제원·옵션을 선택하고 공식 국비·지방비 보조금을 확인하세요.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
