# Generates src-tauri/app-icon.png (1024x1024) and runs `tauri icon`
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;

public class IconGen2009Script {
    private static GraphicsPath RoundedRect(RectangleF bounds, float radius) {
        float d = radius * 2f;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void DrawSlantedBar(Graphics g, Brush brush, float cx, float cy, float w, float h, float slant) {
        PointF[] pts = new PointF[] {
            new PointF(cx - w/2f + slant, cy - h/2f),
            new PointF(cx + w/2f + slant, cy - h/2f),
            new PointF(cx + w/2f - slant, cy + h/2f),
            new PointF(cx - w/2f - slant, cy + h/2f)
        };
        g.FillPolygon(brush, pts);
    }

    public static void Generate(string outPath) {
        int size = 1024;
        using (Bitmap bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp)) {
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);

            RectangleF cardRect = new RectangleF(44, 44, size - 88, size - 88);
            using (GraphicsPath cardPath = RoundedRect(cardRect, 210f)) {
                using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                    new PointF(0, 20), new PointF(0, size - 20),
                    Color.FromArgb(255, 22, 22, 24),
                    Color.FromArgb(255, 5, 5, 6))) {
                    g.FillPath(bgBrush, cardPath);
                }

                g.SetClip(cardPath);

                using (GraphicsPath glowPath = new GraphicsPath()) {
                    glowPath.AddEllipse(-180, -240, 960, 760);
                    using (PathGradientBrush pgb = new PathGradientBrush(glowPath)) {
                        pgb.CenterColor = Color.FromArgb(40, 255, 255, 255);
                        pgb.SurroundColors = new Color[] { Color.FromArgb(0, 255, 255, 255) };
                        g.FillPath(pgb, glowPath);
                    }
                }

                for (int r = 0; r < 14; r++) {
                    for (int c = 0; c < 22; c++) {
                        float nx = (c - 10.5f) / 10.5f;
                        float nz = (r - 6.5f) / 6.5f;
                        float wave = (float)(Math.Sin(c * 0.45 + 0.7) * 26.0 + Math.Cos(r * 0.55) * 18.0);
                        float px = 512f + nx * 460f;
                        float py = 660f + nz * 240f + wave;
                        float edge = Math.Max(0f, 1f - (nx * nx * 0.85f + nz * nz * 0.85f));
                        int alpha = (int)(45f * edge);
                        if (alpha > 3) {
                            float dotR = 3.2f + edge * 2.4f;
                            using (SolidBrush db = new SolidBrush(Color.FromArgb(alpha, 237, 237, 237))) {
                                g.FillEllipse(db, px - dotR, py - dotR, dotR * 2f, dotR * 2f);
                            }
                        }
                    }
                }

                using (Pen tickPen = new Pen(Color.FromArgb(70, 255, 255, 255), 5f)) {
                    g.DrawLine(tickPen, 804, 152, 854, 152);
                    g.DrawLine(tickPen, 854, 152, 854, 202);
                    g.DrawLine(tickPen, 170, 872, 170, 822);
                    g.DrawLine(tickPen, 170, 872, 220, 872);
                }

                float hashCx = 512f;
                float hashCy = 358f;
                using (LinearGradientBrush hashBrush = new LinearGradientBrush(
                    new PointF(hashCx - 220, hashCy - 210),
                    new PointF(hashCx + 220, hashCy + 210),
                    Color.FromArgb(255, 254, 254, 254),
                    Color.FromArgb(255, 178, 178, 185))) {
                    hashBrush.WrapMode = WrapMode.TileFlipXY;
                    DrawSlantedBar(g, hashBrush, hashCx - 68f, hashCy, 44f, 286f, 28f);
                    DrawSlantedBar(g, hashBrush, hashCx + 68f, hashCy, 44f, 286f, 28f);

                    PointF[] hBarTop = new PointF[] {
                        new PointF(hashCx - 168f + 12f, hashCy - 70f),
                        new PointF(hashCx + 178f + 12f, hashCy - 70f),
                        new PointF(hashCx + 178f - 6f, hashCy - 28f),
                        new PointF(hashCx - 168f - 6f, hashCy - 28f),
                    };
                    PointF[] hBarBot = new PointF[] {
                        new PointF(hashCx - 178f + 6f, hashCy + 28f),
                        new PointF(hashCx + 168f + 6f, hashCy + 28f),
                        new PointF(hashCx + 168f - 12f, hashCy + 70f),
                        new PointF(hashCx - 178f - 12f, hashCy + 70f),
                    };
                    g.FillPolygon(hashBrush, hBarTop);
                    g.FillPolygon(hashBrush, hBarBot);
                }

                using (SolidBrush pulseBrush = new SolidBrush(Color.FromArgb(235, 114, 196, 148))) {
                    g.FillEllipse(pulseBrush, 704f, 204f, 24f, 24f);
                }

                FontFamily fam;
                try { fam = new FontFamily("Bahnschrift"); }
                catch {
                    try { fam = new FontFamily("Segoe UI"); }
                    catch { fam = FontFamily.GenericSansSerif; }
                }

                using (StringFormat sf = new StringFormat()) {
                    sf.Alignment = StringAlignment.Center;
                    sf.LineAlignment = StringAlignment.Center;
                    using (GraphicsPath textPath = new GraphicsPath()) {
                        textPath.AddString(
                            "2009",
                            fam,
                            (int)FontStyle.Bold,
                            218f,
                            new RectangleF(70, 560, size - 140, 265),
                            sf
                        );
                        using (LinearGradientBrush textBrush = new LinearGradientBrush(
                            new PointF(0, 510), new PointF(0, 860),
                            Color.FromArgb(255, 252, 252, 252),
                            Color.FromArgb(255, 178, 178, 185))) {
                            textBrush.WrapMode = WrapMode.TileFlipXY;
                            g.FillPath(textBrush, textPath);
                        }
                    }
                }

                g.ResetClip();

                using (Pen borderPen = new Pen(Color.FromArgb(58, 255, 255, 255), 6f)) {
                    borderPen.Alignment = PenAlignment.Inset;
                    g.DrawPath(borderPen, cardPath);
                }
            }

            bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@

$masterPng = Join-Path $root "src-tauri\app-icon.png"
[IconGen2009Script]::Generate($masterPng)
npx.cmd tauri icon $masterPng
Copy-Item (Join-Path $root "src-tauri\icons\128x128.png") (Join-Path $root "public\app-icon.png") -Force
Remove-Item -Recurse -Force (Join-Path $root "src-tauri\icons\ios"), (Join-Path $root "src-tauri\icons\android") -ErrorAction SilentlyContinue
