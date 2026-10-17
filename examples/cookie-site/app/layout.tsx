export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="cs"><body style={{ fontFamily: "system-ui", padding: 24 }}>{children}</body></html>;
}
