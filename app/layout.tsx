import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "LinguaLive｜实时多语言翻译";
const description =
  "支持多种主流语言的实时双语字幕、语音播报、全文记录与单词释义。";
const productionOrigin =
  process.env.PUBLIC_SITE_URL ?? "http://localhost:3000";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    requestHeaders.get("host");
  const safeHost =
    rawHost && /^[a-z0-9.-]+(?::\d+)?$/i.test(rawHost) ? rawHost : null;
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    safeHost?.startsWith("localhost") || safeHost?.startsWith("127.0.0.1")
      ? "http"
      : forwardedProtocol === "http"
        ? "http"
        : "https";
  const origin = safeHost ? `${protocol}://${safeHost}` : productionOrigin;
  const previewImage = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [
        {
          url: previewImage,
          width: 1730,
          height: 909,
          alt: "课堂同传：实时多语言双语字幕与语音播报",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [previewImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
