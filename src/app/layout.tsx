import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "AI Studio - Intelligent Dashboard Builder",
  description: "Generate intelligent dashboards and reports using AI-powered agents. Transform natural language into stunning data visualizations.",
  keywords: ["AI", "Dashboard", "Analytics", "Data Visualization", "Business Intelligence"],
  authors: [{ name: "AI Studio Team" }],
  openGraph: {
    title: "AI Studio - Intelligent Dashboard Builder",
    description: "Generate intelligent dashboards and reports using AI-powered agents.",
    type: "website",
  },
};

import { AntdRegistry } from '@ant-design/nextjs-registry';
import { ConfigProvider, theme, App } from 'antd';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased bg-bg-dark text-white overflow-hidden h-screen`}
        suppressHydrationWarning
      >
        <AntdRegistry>
          <ConfigProvider
            theme={{
              algorithm: theme.darkAlgorithm,
              token: {
                colorPrimary: '#135bec',
                borderRadius: 12,
                colorBgBase: '#080a0f',
                colorBgContainer: '#11141d',
                colorBgElevated: '#1a1f2e',
                colorBorder: 'rgba(255, 255, 255, 0.1)',
                colorTextBase: '#f8fafc',
                colorTextSecondary: '#94a3b8',
              },
              components: {
                Card: {
                  colorBgContainer: '#11141d',
                  borderRadiusLG: 16,
                },
                Button: {
                  borderRadius: 8,
                  controlHeight: 36,
                }
              }
            }}
          >
            <App>
              {children}
            </App>
          </ConfigProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
