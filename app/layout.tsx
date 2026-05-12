import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Steenberg Stocktake',
  description: 'AI-powered shelf photo analyser for Steenberg Veterinary Clinic',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
