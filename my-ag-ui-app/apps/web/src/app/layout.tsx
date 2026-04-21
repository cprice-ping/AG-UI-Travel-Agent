import type { Metadata } from "next";

import { CopilotKit } from "@copilotkit/react-core";
import { SessionProvider } from "next-auth/react";
import "./globals.css";
import "@copilotkit/react-ui/styles.css";

export const metadata: Metadata = {
  title: "AI Travel Agent",
  description: "Plan your dream trip with an AI travel agent powered by Gemini + AG-UI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={"antialiased"}>
        {/* SessionProvider makes useSession() available throughout the app */}
        <SessionProvider refetchOnWindowFocus={true}>
          <CopilotKit runtimeUrl="/api/copilotkit" agent="starterAgent">
            {children}
          </CopilotKit>
        </SessionProvider>
      </body>
    </html>
  );
}
