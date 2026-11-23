// Draws a bundle's icon the way this Mac's Dock and Finder do (NSWorkspace → IconServices), so
// the shipped icon can be checked per macOS version: `swift render-app-icon.swift <app> <out.png> [px]`.
// Side by side: transparent, then the light and the dark appearance on matching backdrops.
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: render-app-icon.swift <bundle.app> <out.png> [px]\n".data(using: .utf8)!)
  exit(2)
}
let px = args.count > 3 ? Int(args[3]) ?? 256 : 256
let icon = NSWorkspace.shared.icon(forFile: args[1])
icon.size = NSSize(width: px, height: px)
let backdrops: [(NSColor?, NSAppearance.Name)] = [
  (nil, .aqua), (NSColor(white: 0.93, alpha: 1), .aqua), (NSColor(white: 0.13, alpha: 1), .darkAqua),
]
let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: px * backdrops.count, pixelsHigh: px, bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
for (i, (color, appearance)) in backdrops.enumerated() {
  let rect = NSRect(x: i * px, y: 0, width: px, height: px)
  if let color { color.setFill(); rect.fill() }
  NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
    icon.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
  }
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
