import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPT 智商检测台",
  description: "持续记录并公开展示大模型逻辑题检测结果",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
